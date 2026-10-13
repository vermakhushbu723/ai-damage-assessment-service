import { Router } from 'express';
import express from 'express';
import { settings } from '../config.js';
import { signToken } from '../utils/jwt.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { asyncHandler, validate, badRequest, notFound, conflict, HttpError, checkPassword, normalizePhone } from '../utils/http.js';
import { fieldAuth, FIELD_ROLES } from '../middleware/fieldAuth.js';
import {
    findUser, findUserRowByLogin, recordUserLoginSuccess, recordUserLoginFailure, setUserPassword,
} from '../models/userModel.js';
import { findRole } from '../models/roleModel.js';
import {
    listInspections, findInspection, insertInspection, updateInspection, setInspectionStatus,
    listMedia, findMediaRow, upsertMedia, deleteMediaRow, countMedia, isOpen,
} from '../models/inspectionModel.js';
import { saveFile, deleteFile, signedMediaUrl, MIME_EXT } from '../services/mediaStore.js';
import { auditEvent } from '../services/audit.js';
import { transaction } from '../db/database.js';

// API of the Pre-Inspection Agent app (preinspection_agent_app), under /api/v1/field.
// Field users are the users created in Admin > Create Users with a
// pre-inspection / surveyor role and Mobile (or Both) platform access.

const router = Router();

export const SURVEY_TYPES = ['pre inspection', 'Valuation'];
export const PRODUCTS = ['Private Car', 'Two Wheeler', 'Commercial Vehicle', 'Taxi'];
// The app's "Select State" list (states + union territories).
export const INDIA_STATES = [
    'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
    'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
    'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
    'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
    'Ladakh', 'Lakshadweep', 'Puducherry',
];
const MEDIA_KINDS = {
    document: 'image', photo: 'image', signature: 'image', reinspection: 'image', repair: 'image', video: 'video',
};
const SLOT_RE = /^[A-Za-z0-9_-]{1,60}$/;

const appUser = (user, appRole) => ({
    id: user.id,
    userId: user.userId,
    name: user.name,
    email: user.email,
    role: appRole,
    roleName: findRole(user.roleKey)?.name ?? user.roleKey,
    organization: user.organization,
    mustChangePassword: user.mustChangePassword,
});

// ---------- sign-in ----------

/**
 * POST /api/v1/field/auth/login { userId (or email), password, role: 'agent' | 'surveyor' }
 * -> { token, expiresIn, user }. 5 wrong passwords lock the account for 15 minutes.
 */
router.post('/auth/login', asyncHandler(async (req, res) => {
    const identifier = String(req.body?.userId ?? '').trim();
    const password = String(req.body?.password ?? '');
    const appRole = req.body?.role;
    if (!identifier || !password) throw badRequest('User ID and password are required.');
    if (!FIELD_ROLES[appRole]) throw badRequest("role must be 'agent' or 'surveyor'.");

    const row = findUserRowByLogin(identifier);
    const actor = row ? { id: row.id, name: row.name, role: 'Field user' } : { name: identifier };
    const fail = (detail, status = 401) => {
        auditEvent(req, { update: 'App login attempt', reference: 'Failed Login', module: 'Field App', status: 'Failed', detail: `${identifier}: ${detail}`, actor });
        throw new HttpError(status, detail);
    };
    if (!row) fail('Invalid user ID or password.');
    if (row.locked_until && new Date(row.locked_until) > new Date()) {
        const minutes = Math.ceil((new Date(row.locked_until) - Date.now()) / 60_000);
        fail(`Too many failed attempts. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.`, 423);
    }
    if (!verifyPassword(password, row.password_hash)) {
        const { lockedUntil, failed } = recordUserLoginFailure(row.id, settings.maxFailedLogins, settings.lockMinutes);
        fail(lockedUntil
            ? `Too many failed attempts. Account locked for ${settings.lockMinutes} minutes.`
            : `Invalid user ID or password. ${settings.maxFailedLogins - failed} attempt(s) left.`);
    }
    const user = findUser(row.id);
    if (user.status !== 'Active') fail(`This account is ${user.status}. Contact your admin.`, 403);
    if (!FIELD_ROLES[appRole].includes(user.roleKey)) {
        fail(appRole === 'agent' ? 'This account is not a pre-inspection agent. Use the Surveyor tab or contact your admin.' : 'This account is not a surveyor. Use the Agent tab or contact your admin.', 403);
    }
    if (user.platform === 'web') fail('This account has web access only. Ask your admin to enable mobile access.', 403);

    recordUserLoginSuccess(user.id);
    const token = signToken({ sub: user.id, kind: 'field', role: appRole }, settings.jwtSecret, settings.fieldJwtExpiresInSeconds);
    auditEvent(req, { update: 'App login', reference: 'Login', module: 'Field App', actor });
    res.json({ token, expiresIn: settings.fieldJwtExpiresInSeconds, user: appUser(user, appRole) });
}));

router.get('/auth/me', fieldAuth, (req, res) => res.json({ user: appUser(req.fieldUser, req.fieldUser.appRole) }));

router.post('/auth/logout', fieldAuth, (req, res) => {
    auditEvent(req, { update: 'App logout', reference: 'Logout', module: 'Field App', actor: { id: req.fieldUser.id, name: req.fieldUser.name, role: 'Field user' } });
    res.json({ ok: true });
});

/** POST /api/v1/field/auth/change-password { currentPassword, newPassword } */
router.post('/auth/change-password', fieldAuth, asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    const row = findUserRowByLogin(req.fieldUser.userId);
    if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) throw badRequest('Current password is incorrect.');
    checkPassword(newPassword, 'New password');
    if (newPassword === currentPassword) throw badRequest('New password must be different from the current one.');
    setUserPassword(row.id, hashPassword(newPassword), { mustChange: false });
    res.json({ ok: true });
}));

// ---------- inspections ----------

const OWNER_SPEC = {
    surveyType: { required: true, oneOf: SURVEY_TYPES, label: 'Survey type' },
    ownerName: { required: true, max: 80, label: 'Owner name' },
    mobile: { required: true, phone: true, label: 'Mobile number' },
    email: { required: true, email: true, max: 120, label: 'Email' },
    odometer: { required: true, max: 10, label: 'Odometer reading' },
    registrationNumber: { required: true, max: 15, label: 'Registration number' },
    state: { required: true, oneOf: INDIA_STATES, label: 'State' },
    registrationDate: { required: true, max: 10, label: 'Registration date' },
    product: { required: true, oneOf: PRODUCTS, label: 'Product' },
    make: { required: true, max: 60, label: 'Make' },
    model: { required: true, max: 60, label: 'Model' },
    variant: { required: true, max: 80, label: 'Variant' },
    manufacturingYear: { required: true, max: 7, label: 'Manufacturing year' },
    ownerSerialNumber: { required: true, max: 2, label: 'Owner serial number' },
    idv: { max: 15, label: 'Present market value / IDV' },
};

function checkOwner(body) {
    if (body.odometer != null && !/^\d{1,9}$/.test(body.odometer)) throw badRequest('Odometer reading must be a number.');
    if (body.registrationNumber != null) {
        body.registrationNumber = body.registrationNumber.toUpperCase().replace(/\s+/g, '');
        if (!/^[A-Z0-9]{4,15}$/.test(body.registrationNumber)) throw badRequest('Registration number: letters and numbers only.');
    }
    if (body.registrationDate != null && !/^\d{2}-\d{2}-\d{4}$/.test(body.registrationDate)) throw badRequest('Registration date must be DD-MM-YYYY.');
    if (body.manufacturingYear != null && !/^\d{2}-\d{4}$/.test(body.manufacturingYear)) throw badRequest('Manufacturing year must be MM-YYYY.');
    if (body.ownerSerialNumber != null && !/^[1-9]$/.test(body.ownerSerialNumber)) throw badRequest('Owner serial number must be 1-9.');
    if (body.idv != null && body.idv !== '' && !/^[\d,]{1,15}$/.test(body.idv)) throw badRequest('Market value must be a number.');
    if (body.mobile) body.mobile = normalizePhone(body.mobile);
    if (body.surveyType === 'Valuation' && !body.idv) throw badRequest('Present market value is required for a valuation.');
}

/**
 * Repair & reinspection photos can follow a submitted survey when the
 * vehicle needs repair: a damage-photo survey, the agent marked it not
 * recommended, or the admin rejected it. Once per case.
 */
export const canSubmitRepair = (i) => !i.repairSubmittedAt && ['Submitted', 'Approved', 'Rejected'].includes(i.status)
    && (i.workflow === 'damage' || i.agentRecommendation === 'Rejected' || i.status === 'Rejected');

/** Dashboard row of the app (its claim card). */
const card = (i) => ({
    id: i.id,
    piRef: i.id,
    insurerName: settings.organizationName,
    registrationNumber: i.registrationNumber,
    insuredName: i.ownerName,
    vehicle: [i.make, i.model].filter(Boolean).join(' '),
    status: isOpen(i) ? 'Pending' : 'Completed',
    inspectionStatus: i.status,
    workflow: i.workflow,
    surveyType: i.surveyType,
    surveyDate: (i.submittedAt ?? i.createdAt).slice(0, 10),
    location: i.state ?? '',
    amount: i.idv ? `₹ ${i.idv}` : '',
    repairSubmittedAt: i.repairSubmittedAt,
    canSubmitRepair: canSubmitRepair(i),
    reviewRemarks: i.reviewRemarks,
});

const withMedia = (i) => ({
    ...card(i),
    details: i,
    media: listMedia(i.id).map((m) => ({ ...m, url: signedMediaUrl(i.id, m.id) })),
});

/** The caller's own inspection, or 404 (another agent's ids are invisible). */
function ownInspection(req) {
    const i = findInspection(req.params.id);
    if (!i || i.agentId !== req.fieldUser.id) throw notFound('Pre-inspection');
    return i;
}

/** GET /api/v1/field/inspections -> the signed-in user's inspections (dashboard). */
router.get('/inspections', fieldAuth, (req, res) => res.json(listInspections({ agentId: req.fieldUser.id }).map(card)));

/** POST /api/v1/field/inspections -- Owner & Vehicle Details "Next": starts a draft. */
router.post('/inspections', fieldAuth, asyncHandler(async (req, res) => {
    const body = validate(req.body, OWNER_SPEC);
    checkOwner(body);
    const inspection = insertInspection({ agentId: req.fieldUser.id, agentRole: req.fieldUser.appRole, fields: body });
    res.status(201).json(withMedia(inspection));
}));

router.get('/inspections/:id', fieldAuth, (req, res) => res.json(withMedia(ownInspection(req))));

/**
 * PATCH /api/v1/field/inspections/:id -- edits of a draft: owner & vehicle
 * form, workflow (damage | others), recommendation, declarations, location.
 */
router.patch('/inspections/:id', fieldAuth, asyncHandler(async (req, res) => {
    const current = ownInspection(req);
    if (!isOpen(current)) throw conflict('This pre-inspection is already submitted.');
    const body = validate(req.body, {
        ...Object.fromEntries(Object.entries(OWNER_SPEC).map(([k, v]) => [k, { ...v }])),
        workflow: { oneOf: ['damage', 'others'], label: 'Workflow' },
        agentRecommendation: { oneOf: ['Approved', 'Rejected'], label: 'Recommendation' },
        customerDeclaration: { type: 'boolean', label: 'Customer declaration' },
        inspectorDeclaration: { type: 'boolean', label: 'Inspector declaration' },
        latitude: { type: 'number', label: 'Latitude' },
        longitude: { type: 'number', label: 'Longitude' },
    }, { partial: true });
    for (const k of Object.keys(OWNER_SPEC)) if (k in body && body[k] === null && OWNER_SPEC[k].required) throw badRequest(`${OWNER_SPEC[k].label} is required.`);
    checkOwner(body);
    if ((body.latitude != null && Math.abs(body.latitude) > 90) || (body.longitude != null && Math.abs(body.longitude) > 180)) throw badRequest('Location is out of range.');
    const updated = updateInspection(current.id, body);
    // The agent has started an assigned case.
    res.json(withMedia(current.status === 'Assigned' ? setInspectionStatus(current.id, 'Draft') : updated));
}));

/**
 * PUT /api/v1/field/inspections/:id/media/:kind/:slot  (raw body, Content-Type = the file's type)
 * Query: lat, lng, capturedAt (optional). Re-uploading a slot replaces its file.
 * kinds: document | photo | video | signature (draft only), reinspection | repair (after a damage-workflow submit).
 */
router.put('/inspections/:id/media/:kind/:slot', fieldAuth,
    express.raw({ type: () => true, limit: `${Math.max(settings.maxPhotoMb, settings.maxVideoMb)}mb` }),
    asyncHandler(async (req, res) => {
        const inspection = ownInspection(req);
        const { kind, slot } = req.params;
        if (!MEDIA_KINDS[kind]) throw badRequest(`kind must be one of: ${Object.keys(MEDIA_KINDS).join(', ')}.`);
        if (!SLOT_RE.test(slot)) throw badRequest('slot: letters, numbers, - and _ only.');
        const afterSubmit = ['reinspection', 'repair'].includes(kind);
        if (afterSubmit) {
            if (inspection.repairSubmittedAt) throw conflict('Repair & reinspection photos were already submitted.');
            if (!canSubmitRepair(inspection)) throw conflict('Repair & reinspection photos are only taken after a submitted survey that needs repair.');
        } else if (inspection.status !== 'Draft') {
            throw conflict(inspection.status === 'Assigned' ? 'Save the owner & vehicle details first.' : 'This pre-inspection is already submitted.');
        }

        const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const family = MEDIA_KINDS[kind];
        if (!MIME_EXT[mime] || !(mime.startsWith(`${family}/`) || (kind === 'document' && mime === 'application/pdf'))) {
            throw badRequest(`Unsupported file type "${mime || 'none'}" for ${kind}.`);
        }
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!bytes.length) throw badRequest('The file is empty.');
        const maxMb = family === 'video' ? settings.maxVideoMb : settings.maxPhotoMb;
        if (bytes.length > maxMb * 1024 * 1024) throw new HttpError(413, `File is larger than ${maxMb} MB.`);

        const lat = req.query.lat !== undefined ? Number(req.query.lat) : null;
        const lng = req.query.lng !== undefined ? Number(req.query.lng) : null;
        if ((lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) || (lng !== null && (!Number.isFinite(lng) || Math.abs(lng) > 180))) throw badRequest('Location is out of range.');
        const capturedAt = req.query.capturedAt && !Number.isNaN(Date.parse(req.query.capturedAt)) ? new Date(req.query.capturedAt).toISOString() : null;

        const fileName = saveFile(inspection.id, kind, slot, mime, bytes);
        let result;
        try {
            result = transaction(() => upsertMedia({ inspectionId: inspection.id, kind, slot, mime, sizeBytes: bytes.length, fileName, latitude: lat, longitude: lng, capturedAt }));
        } catch (err) {
            deleteFile(fileName);
            throw err;
        }
        if (result.replacedFile) deleteFile(result.replacedFile);
        res.status(201).json({ ...result.media, url: signedMediaUrl(inspection.id, result.media.id) });
    }));

/** DELETE /api/v1/field/inspections/:id/media/:mediaId -- e.g. removing an extra damage photo. */
router.delete('/inspections/:id/media/:mediaId', fieldAuth, asyncHandler(async (req, res) => {
    const inspection = ownInspection(req);
    const row = findMediaRow(inspection.id, req.params.mediaId);
    if (!row) throw notFound('File');
    const afterSubmit = ['reinspection', 'repair'].includes(row.kind);
    if (afterSubmit ? Boolean(inspection.repairSubmittedAt) : !isOpen(inspection)) throw conflict('This file is already submitted.');
    deleteMediaRow(inspection.id, row.id);
    deleteFile(row.file_name);
    res.json({ ok: true });
}));

const REQUIRED_OWNER = Object.entries(OWNER_SPEC).filter(([, v]) => v.required).map(([k]) => k);

/**
 * POST /api/v1/field/inspections/:id/submit -- Damage Review "Submit" /
 * Vehicle Information "Submit". Checks the survey is complete first.
 */
router.post('/inspections/:id/submit', fieldAuth, asyncHandler(async (req, res) => {
    const i = ownInspection(req);
    if (i.status === 'Assigned') throw badRequest('Fill in the owner & vehicle details first.');
    if (i.status !== 'Draft') throw conflict('This pre-inspection is already submitted.');
    const missing = REQUIRED_OWNER.filter((k) => !i[k] && k !== 'registrationNumber' && k !== 'ownerName');
    if (missing.length) throw badRequest(`Owner & vehicle details are incomplete: ${missing.join(', ')}.`);
    if (!i.workflow) throw badRequest('Choose how to continue on the photo capture screen first.');
    if (!countMedia(i.id, 'photo')) throw badRequest('Capture the vehicle photos before submitting.');
    if (i.workflow === 'others') {
        const sigs = listMedia(i.id).filter((m) => m.kind === 'signature').map((m) => m.slot);
        if (!sigs.includes('customer') || !sigs.includes('inspector')) throw badRequest('Please capture both signatures.');
        if (!i.customerDeclaration || !i.inspectorDeclaration) throw badRequest('Both declarations must be accepted.');
        if (!i.agentRecommendation) throw badRequest('Choose whether this pre-inspection is recommended.');
    }
    const updated = setInspectionStatus(i.id, 'Submitted', { submitted_at: new Date().toISOString() });
    auditEvent(req, { update: `Pre-inspection ${i.id} submitted`, reference: 'Created', module: 'Pre-Inspection', actor: { id: req.fieldUser.id, name: req.fieldUser.name, role: 'Field user' } });
    res.json(withMedia(updated));
}));

/**
 * POST /api/v1/field/inspections/:id/repair-submit -- Repair Submission "Submit".
 * A rejected case goes back to the admin for review (Pending Review).
 */
router.post('/inspections/:id/repair-submit', fieldAuth, asyncHandler(async (req, res) => {
    const i = ownInspection(req);
    if (i.repairSubmittedAt) throw conflict('Repair & reinspection photos were already submitted.');
    if (!canSubmitRepair(i)) throw conflict('Repair photos are only submitted after a survey that needs repair.');
    if (!countMedia(i.id, 'reinspection') && !countMedia(i.id, 'repair')) throw badRequest('Add the reinspection photos or the repair bill first.');
    const updated = setInspectionStatus(i.id, i.status === 'Rejected' ? 'Submitted' : i.status, { repair_submitted_at: new Date().toISOString() });
    auditEvent(req, { update: `Pre-inspection ${i.id}: repair & reinspection submitted`, reference: 'Updated', module: 'Pre-Inspection', actor: { id: req.fieldUser.id, name: req.fieldUser.name, role: 'Field user' } });
    res.json(withMedia(updated));
}));

export default router;
