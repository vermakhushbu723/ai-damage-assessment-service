import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound, forbidden, conflict, checkPassword, normalizePhone } from '../utils/http.js';
import { authenticate, serviceModelOfAdmin } from '../middleware/authenticate.js';
import { ORG_TYPES, ORG_STATUSES, ID_TYPES, SERVICE_MODELS } from '../constants.js';
import { transaction } from '../db/database.js';
import {
    listOrganizations, findOrganization, insertOrganization, updateOrganization, orgNameTaken,
} from '../models/organizationModel.js';
import { findPlan } from '../models/planModel.js';
import { insertUser, userIdTaken } from '../models/userModel.js';
import { hashPassword } from '../utils/password.js';
import { generatePassword, nextSequentialId } from '../utils/ids.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(authenticate);

// Passwords typed into the creation form are hashed onto the user row; they
// must never be stored in the organization's form JSON.
const stripSecrets = (form = {}) => Object.fromEntries(Object.entries(form).filter(([k]) => !/password/i.test(k)));

const addMonths = (iso, months) => {
    const d = new Date(iso);
    d.setMonth(d.getMonth() + months);
    return d.toISOString();
};

/** 404 (not 403) for another scope's organization, so scoped admins can't probe IDs. */
function loadOwnOrganization(req) {
    const org = findOrganization(req.params.id);
    const own = serviceModelOfAdmin(req.admin);
    if (!org || (own && org.serviceModel !== own)) throw notFound('Organization');
    return org;
}

function assertServiceModelAllowed(admin, serviceModel) {
    const own = serviceModelOfAdmin(admin);
    if (own && serviceModel !== own) throw forbidden(`You can only manage ${own} organizations.`);
}

/** GET /api/v1/organizations -> organizations this admin manages (newest first, with live user counts). */
router.get('/', (req, res) => {
    res.json(listOrganizations(serviceModelOfAdmin(req.admin)));
});

router.get('/:id', (req, res) => res.json(loadOwnOrganization(req)));

/**
 * POST /api/v1/organizations -- "Create Pilot ID" / "Create Working ID".
 * Body: { type, serviceModel, idType, name, plan, subscriptionStart, validityMonths, workflow, settings, form,
 *         admin: { name, email, phone, password? } }
 * Creates the organization AND its admin login (a row in users) in one transaction.
 * Returns { organization, credentials } -- the temporary password is only ever returned here.
 */
router.post('/', asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        type: { required: true, oneOf: ORG_TYPES, label: 'Organization type' },
        serviceModel: { required: true, oneOf: SERVICE_MODELS, label: 'Service model' },
        idType: { oneOf: ID_TYPES, label: 'ID type' },
        name: { required: true, min: 2, max: 150, label: 'Organization name' },
        plan: { required: true, label: 'Plan' },
        subscriptionStart: { required: true, label: 'Subscription start date' },
        validityMonths: { required: true, type: 'number', min: 1, label: 'Validity' },
        workflow: { type: 'object' },
        settings: { type: 'object' },
        form: { type: 'object' },
        admin: { required: true, type: 'object', label: 'Organization admin' },
    });
    assertServiceModelAllowed(req.admin, body.serviceModel);
    if (!findPlan(body.plan)) throw badRequest('Selected plan does not exist.');
    if (Number.isNaN(Date.parse(body.subscriptionStart))) throw badRequest('Subscription start date is invalid.');
    if (orgNameTaken(body.name)) throw conflict(`An organization named "${body.name}" already exists.`);

    const admin = validate(body.admin, {
        name: { required: true, min: 2, label: 'Admin name' },
        email: { required: true, email: true, label: 'Admin email' },
        phone: { phone: true, label: 'Admin mobile number' },
        password: { label: 'Temporary password' },
    });
    const password = admin.password || generatePassword();
    checkPassword(password, 'Temporary password');

    const result = transaction(() => {
        const id = nextSequentialId('organizations', 'ORG', 1000);
        const loginId = `${id}-${body.type === 'Surveyor' ? 'USR' : 'ADM'}`;
        if (userIdTaken(loginId)) throw conflict(`Login ID ${loginId} already exists.`);
        const organization = insertOrganization({
            id,
            name: body.name,
            type: body.type,
            status: 'Active', // a new Pilot or Working ID is live immediately
            idType: body.idType ?? 'Working',
            serviceModel: body.serviceModel,
            plan: body.plan,
            subscriptionStart: new Date(body.subscriptionStart).toISOString(),
            subscriptionExpiry: addMonths(body.subscriptionStart, body.validityMonths),
            adminLoginId: loginId,
            workflow: body.workflow ?? {},
            settings: { ...(body.settings ?? {}), validityMonths: body.validityMonths },
            form: stripSecrets(body.form),
            createdBy: req.admin.id,
        });
        insertUser({
            id: loginId,
            organizationId: id,
            name: admin.name,
            email: admin.email,
            phone: admin.phone ? normalizePhone(admin.phone) : null,
            role: body.type === 'Surveyor' ? 'Surveyor' : 'Admin',
            branch: null,
            platform: body.type === 'Surveyor' ? 'Mobile' : 'Web',
            status: 'Active',
            passwordHash: hashPassword(password),
            mustChangePassword: true,
        });
        return { organization: findOrganization(id), loginId };
    });

    audit(req, { action: 'Created', module: 'Organizations', detail: `${result.organization.id} ${result.organization.name} (${body.idType ?? 'Working'} ID)` });
    res.status(201).json({
        organization: result.organization,
        credentials: {
            orgId: result.organization.id,
            loginId: result.loginId,
            email: admin.email,
            password,
            validTill: result.organization.subscriptionExpiry,
        },
    });
}));

/**
 * PATCH /api/v1/organizations/:id -- inline Status / Subscription edits and "Edit & Modify Profile".
 * Any subset of: name, status, idType, serviceModel, plan, subscriptionStart, validityMonths, subscriptionExpiry, workflow, settings, form.
 */
router.patch('/:id', asyncHandler(async (req, res) => {
    const org = loadOwnOrganization(req);
    const patch = validate(req.body, {
        name: { min: 2, max: 150, label: 'Organization name' },
        status: { oneOf: ORG_STATUSES, label: 'Status' },
        idType: { oneOf: ID_TYPES, label: 'ID type' },
        serviceModel: { oneOf: SERVICE_MODELS, label: 'Service model' },
        plan: { label: 'Plan' },
        subscriptionStart: { label: 'Subscription start date' },
        validityMonths: { type: 'number', min: 1, label: 'Validity' },
        subscriptionExpiry: { label: 'Subscription expiry' },
        workflow: { type: 'object' },
        settings: { type: 'object' },
        form: { type: 'object' },
    }, { partial: true });

    if (patch.serviceModel) assertServiceModelAllowed(req.admin, patch.serviceModel);
    if (patch.plan && !findPlan(patch.plan)) throw badRequest('Selected plan does not exist.');
    if (patch.name && orgNameTaken(patch.name, org.id)) throw conflict(`An organization named "${patch.name}" already exists.`);
    for (const key of ['subscriptionStart', 'subscriptionExpiry']) {
        if (patch[key] && Number.isNaN(Date.parse(patch[key]))) throw badRequest(`${key} is not a valid date.`);
        if (patch[key]) patch[key] = new Date(patch[key]).toISOString();
    }
    if (patch.validityMonths) {
        patch.subscriptionExpiry = addMonths(patch.subscriptionStart ?? org.subscriptionStart ?? org.createdOn, patch.validityMonths);
        patch.settings = { ...(patch.settings ?? org.settings), validityMonths: patch.validityMonths };
    }
    if (patch.form) patch.form = stripSecrets(patch.form);

    const updated = updateOrganization(org.id, patch);
    const changed = Object.keys(patch).filter((k) => !['form', 'workflow', 'settings'].includes(k));
    audit(req, { action: 'Updated', module: 'Organizations', detail: `${org.id} ${changed.length ? changed.map((k) => `${k}=${typeof patch[k] === 'object' ? '…' : patch[k]}`).join(', ') : 'profile'}` });
    res.json(updated);
}));

export default router;

