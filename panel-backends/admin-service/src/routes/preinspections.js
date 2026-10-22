import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound, conflict, normalizePhone } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import {
    listInspections, findInspection, insertInspection, setInspectionStatus, setInspectionAgent, deleteInspection, listMedia, findMediaRow, isOpen,
    upsertMedia, deleteMediaRow,
} from '../models/inspectionModel.js';
import { findUser } from '../models/userModel.js';
import { FIELD_ROLES } from '../middleware/fieldAuth.js';
import { signedMediaUrl, verifyMediaSignature, filePath, saveFile, deleteFile } from '../services/mediaStore.js';
import { readDmsUpload, DMS_RAW_BODY } from '../services/dmsUpload.js';
import { normalizeSlot } from './field.js';
import { transaction } from '../db/database.js';
import { auditEvent } from '../services/audit.js';

// Admin panel side of the Pre-Inspection Agent app: assigning cases to
// agents/surveyors, what they submitted (photos, video, documents,
// signatures) and the admin's Approve / Reject review.

const router = Router();

const withMedia = (i) => ({ ...i, media: listMedia(i.id).map((m) => ({ ...m, url: signedMediaUrl(i.id, m.id) })) });

/** GET /api/v1/preinspections -> every pre-inspection (drafts included), newest first. */
router.get('/preinspections', authenticate, (_req, res) => res.json(listInspections()));

/** GET /api/v1/preinspections/:id -> full details + signed file links. */
router.get('/preinspections/:id', authenticate, (req, res) => {
    const i = findInspection(req.params.id);
    if (!i) throw notFound('Pre-inspection');
    res.json(withMedia(i));
});

/** The app user a case is assigned to: active, a pre-inspection agent / surveyor, with mobile access. */
function fieldAgent(agentId) {
    const user = agentId && findUser(agentId);
    if (!user) throw badRequest('Select the agent or surveyor.');
    const appRole = Object.keys(FIELD_ROLES).find((r) => FIELD_ROLES[r].includes(user.roleKey));
    if (!appRole) throw badRequest(`${user.name} is not a pre-inspection agent or surveyor.`);
    if (user.status !== 'Active') throw badRequest(`${user.name} is ${user.status}.`);
    if (user.platform === 'web') throw badRequest(`${user.name} has web access only -- enable mobile access in Create Users.`);
    return { user, appRole };
}

/**
 * POST /api/v1/preinspections { agentId, ownerName, mobile, registrationNumber, email?, surveyType? }
 * "+ Assign Pre-Inspection": the case appears as Pending on that agent's app dashboard.
 */
router.post('/preinspections', authenticate, asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        agentId: { required: true, label: 'Agent / surveyor' },
        ownerName: { required: true, max: 80, label: 'Insured name' },
        mobile: { required: true, phone: true, label: 'Mobile number' },
        registrationNumber: { required: true, max: 15, label: 'Registration number' },
        email: { email: true, max: 120, label: 'Email' },
        surveyType: { oneOf: ['pre inspection', 'Valuation'], label: 'Survey type' },
    });
    const registrationNumber = body.registrationNumber.toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9]{4,15}$/.test(registrationNumber)) throw badRequest('Registration number: letters and numbers only.');
    const { user, appRole } = fieldAgent(body.agentId);
    const fields = { ownerName: body.ownerName, mobile: normalizePhone(body.mobile), registrationNumber, surveyType: body.surveyType ?? 'pre inspection', ...(body.email ? { email: body.email } : {}) };
    const created = insertInspection({ agentId: user.id, agentRole: appRole, fields, status: 'Assigned', assignedBy: req.admin.name });
    auditEvent(req, { update: `Pre-inspection ${created.id} assigned to ${user.name}`, reference: 'Created', module: 'Pre-Inspection' });
    res.status(201).json(withMedia(created));
}));

/** PATCH /api/v1/preinspections/:id/assign { agentId } -- reassign while the agent has not submitted. */
router.patch('/preinspections/:id/assign', authenticate, asyncHandler(async (req, res) => {
    const i = findInspection(req.params.id);
    if (!i) throw notFound('Pre-inspection');
    if (!isOpen(i)) throw conflict('Submitted pre-inspections cannot be reassigned.');
    const { user, appRole } = fieldAgent(req.body?.agentId);
    const updated = setInspectionAgent(i.id, user.id, appRole);
    auditEvent(req, { update: `Pre-inspection ${i.id} reassigned to ${user.name}`, reference: 'Updated', module: 'Pre-Inspection' });
    res.json(withMedia(updated));
}));

/** DELETE /api/v1/preinspections/:id -- cancel an assigned case the agent has not started. */
router.delete('/preinspections/:id', authenticate, asyncHandler(async (req, res) => {
    const i = findInspection(req.params.id);
    if (!i) throw notFound('Pre-inspection');
    if (i.status !== 'Assigned') throw conflict('Only a case the agent has not started can be cancelled.');
    deleteInspection(i.id);
    auditEvent(req, { update: `Pre-inspection ${i.id} cancelled`, reference: 'Updated', module: 'Pre-Inspection' });
    res.json({ ok: true });
}));

/** PATCH /api/v1/preinspections/:id/review { decision: 'Approved' | 'Rejected', remarks } */
router.patch('/preinspections/:id/review', authenticate, asyncHandler(async (req, res) => {
    const i = findInspection(req.params.id);
    if (!i) throw notFound('Pre-inspection');
    if (isOpen(i)) throw conflict('This pre-inspection has not been submitted yet.');
    const body = validate(req.body, {
        decision: { required: true, oneOf: ['Approved', 'Rejected'], label: 'Decision' },
        remarks: { max: 500, label: 'Remarks' },
    });
    if (body.decision === 'Rejected' && !body.remarks) throw badRequest('Give a reason for rejecting.');
    const updated = setInspectionStatus(i.id, body.decision, {
        reviewed_at: new Date().toISOString(), reviewed_by: req.admin.name, review_remarks: body.remarks ?? null,
    });
    auditEvent(req, { update: `Pre-inspection ${i.id}: ${body.decision}`, reference: 'Updated', module: 'Pre-Inspection', detail: body.remarks ?? null });
    res.json(withMedia(updated));
}));

// Document types of the app's Document Upload screen (slot = `<type>_<side or n>`).
export const INSPECTION_DOC_TYPES = ['policy_copy', 'puc', 'rc', 'aadhar', 'pan', 'others'];

/**
 * PUT /api/v1/preinspections/:id/documents/:slot (raw body, Content-Type = file type)
 * Documents DMS: the admin adds a document (new slot, e.g. `rc_dms-171...`) or
 * replaces one (an existing slot). The slot must start with a document type.
 */
router.put('/preinspections/:id/documents/:slot', authenticate, DMS_RAW_BODY, asyncHandler(async (req, res) => {
    const i = findInspection(req.params.id);
    if (!i) throw notFound('Pre-inspection');
    const slot = normalizeSlot(req.params.slot);
    if (!slot || !INSPECTION_DOC_TYPES.some((t) => slot === t || slot.startsWith(`${t}_`))) {
        throw badRequest(`Slot must start with a document type: ${INSPECTION_DOC_TYPES.join(', ')}.`);
    }
    const { mime, bytes, originalName } = readDmsUpload(req);
    const fileName = saveFile(i.id, 'document', slot, mime, bytes);
    let result;
    try {
        result = transaction(() => upsertMedia({ inspectionId: i.id, kind: 'document', slot, mime, sizeBytes: bytes.length, fileName, capturedAt: new Date().toISOString() }));
    } catch (err) {
        deleteFile(fileName);
        throw err;
    }
    if (result.replacedFile) deleteFile(result.replacedFile);
    auditEvent(req, {
        update: `Pre-inspection ${i.id}: document ${slot} ${result.replacedFile ? 'replaced' : 'uploaded'} (${originalName})`,
        reference: result.replacedFile ? 'Updated' : 'Created',
        module: 'Documents DMS',
    });
    res.status(201).json({ ...result.media, url: signedMediaUrl(i.id, result.media.id) });
}));

/** DELETE /api/v1/preinspections/:id/documents/:mediaId -- remove a document from the DMS. */
router.delete('/preinspections/:id/documents/:mediaId', authenticate, asyncHandler(async (req, res) => {
    const row = findMediaRow(req.params.id, req.params.mediaId);
    if (!row || row.kind !== 'document') throw notFound('Document');
    deleteMediaRow(req.params.id, row.id);
    deleteFile(row.file_name);
    auditEvent(req, { update: `Pre-inspection ${req.params.id}: document ${row.slot} removed`, reference: 'Updated', module: 'Documents DMS' });
    res.json({ ok: true });
}));

/**
 * GET /api/v1/media/:inspectionId/:mediaId?exp=&sig= (public, signed link)
 * Serves one stored file -- range requests work, so videos can be scrubbed.
 */
router.get('/media/:inspectionId/:mediaId', (req, res) => {
    const { inspectionId, mediaId } = req.params;
    if (!verifyMediaSignature(inspectionId, mediaId, req.query.exp, req.query.sig)) {
        return res.status(403).json({ detail: 'This link has expired. Reload the page.' });
    }
    const row = findMediaRow(inspectionId, mediaId);
    const abs = row && filePath(row.file_name);
    if (!abs) return res.status(404).json({ detail: 'File not found.' });
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.type(row.mime).sendFile(abs);
});

export default router;
