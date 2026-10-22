import express, { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { asyncHandler, validate, notFound, badRequest } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import {
    ENQUIRY_ORG_TYPES, ENQUIRY_INTERESTS, ENQUIRY_STATUSES, ENQUIRY_PHONE_RE, ENQUIRY_EMAIL_RE,
} from '../constants.js';
import {
    listEnquiries, findEnquiry, insertEnquiry, updateEnquiry, deleteEnquiry,
    listEnquiryFiles, findEnquiryFileRow, enquiryFileNames, insertEnquiryFile, deleteEnquiryFileRow,
} from '../models/enquiryModel.js';
import { saveFile, deleteFile, filePath, signedEnquiryFileUrl, verifyMediaSignature } from '../services/mediaStore.js';
import { readDmsUpload, DMS_RAW_BODY } from '../services/dmsUpload.js';
import { ipOf, auditEvent } from '../services/audit.js';

// Contact enquiries from the IBima Assist app (ibima-assist-app = the
// website's Android build). The app posts to the public route; the admin
// panel's Enquiries page reads and follows them up.

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Same rules as the website's Contact form -> { data, errors } (field -> message). */
export function validateEnquiry(body = {}) {
    const data = {
        name: str(body.name),
        organisation: str(body.organisation),
        email: str(body.email).toLowerCase(),
        phone: str(body.phone),
        orgType: str(body.orgType),
        interest: str(body.interest),
        message: str(body.message),
    };
    const errors = {};
    if (!data.name) errors.name = 'Please enter your name';
    else if (data.name.length > 120) errors.name = 'Name is too long';
    if (!data.organisation) errors.organisation = 'Please enter your organisation';
    else if (data.organisation.length > 160) errors.organisation = 'Organisation is too long';
    if (!data.email) errors.email = 'Please enter your email';
    else if (!ENQUIRY_EMAIL_RE.test(data.email) || data.email.length > 160) errors.email = 'That does not look like a valid email';
    if (!data.phone) errors.phone = 'Please enter a contact number';
    else if (!ENQUIRY_PHONE_RE.test(data.phone)) errors.phone = 'Please enter a valid phone number';
    if (data.orgType && !ENQUIRY_ORG_TYPES.includes(data.orgType)) errors.orgType = 'Unknown organisation type';
    if (data.interest && !ENQUIRY_INTERESTS.includes(data.interest)) errors.interest = 'Unknown solution';
    if (!data.message) errors.message = 'A line or two is enough';
    else if (data.message.length > 4000) errors.message = 'Message is too long (4000 characters max)';
    return { data, errors };
}

// ---------- public (the app) ----------

// Light per-IP throttle; only accepted enquiries count.
const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = Number(process.env.ENQUIRY_RATE_LIMIT) || 20;

export const publicRouter = Router();

/**
 * POST /api/v1/public/enquiries -- the app's Contact form.
 * Errors use the website's shape: { message, errors: { field: text } }.
 */
publicRouter.post('/enquiries', (req, res) => {
    const ip = ipOf(req);
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
    hits.set(ip, recent);
    if (recent.length >= MAX_PER_WINDOW) {
        return res.status(429).json({ message: 'Too many enquiries from this network. Please try again later.' });
    }
    const { data, errors } = validateEnquiry(req.body ?? {});
    if (Object.keys(errors).length) return res.status(400).json({ message: 'Please check the form', errors });
    const source = str(req.body?.channel) === 'website' ? 'website' : 'app';
    const enquiry = insertEnquiry({
        ...data,
        source,
        sourcePage: str(req.body?.source).slice(0, 120) || null,
        ip,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    });
    recent.push(now);
    return res.status(201).json({ message: 'Enquiry received', id: enquiry.id });
});

// ---------- admin panel ----------

export const adminRouter = Router();

/** GET /api/v1/enquiries -> newest first. */
adminRouter.get('/enquiries', authenticate, (_req, res) => res.json(listEnquiries()));

/** Enquiry + the files attached to it in Documents DMS (signed links). */
const withFiles = (e) => ({ ...e, files: listEnquiryFiles(e.id).map((f) => ({ ...f, url: signedEnquiryFileUrl(e.id, f.id) })) });

adminRouter.get('/enquiries/:id', authenticate, (req, res) => {
    const e = findEnquiry(req.params.id);
    if (!e) throw notFound('Enquiry');
    res.json(withFiles(e));
});

export const ENQUIRY_DOC_TYPES = ['proposal', 'agreement', 'kyc', 'other'];

/**
 * PUT /api/v1/enquiries/:id/files/:docType (raw body, Content-Type = file type,
 * X-File-Name = original name) -- Documents DMS upload. JPG / PNG / WEBP / PDF.
 */
adminRouter.put('/enquiries/:id/files/:docType', authenticate, DMS_RAW_BODY, asyncHandler(async (req, res) => {
    const e = findEnquiry(req.params.id);
    if (!e) throw notFound('Enquiry');
    const { docType } = req.params;
    if (!ENQUIRY_DOC_TYPES.includes(docType)) throw badRequest(`Document type must be one of: ${ENQUIRY_DOC_TYPES.join(', ')}.`);
    const { mime, bytes, originalName } = readDmsUpload(req);
    const id = randomBytes(9).toString('base64url');
    const fileName = saveFile(e.id, 'file', docType, mime, bytes);
    const file = insertEnquiryFile({ id, enquiryId: e.id, docType, originalName, mime, sizeBytes: bytes.length, fileName, uploadedBy: req.admin.name });
    auditEvent(req, { update: `Enquiry ${e.id}: ${originalName} uploaded`, reference: 'Created', module: 'Documents DMS' });
    res.status(201).json({ ...file, url: signedEnquiryFileUrl(e.id, id) });
}));

/** DELETE /api/v1/enquiries/:id/files/:fileId */
adminRouter.delete('/enquiries/:id/files/:fileId', authenticate, asyncHandler(async (req, res) => {
    const row = findEnquiryFileRow(req.params.id, req.params.fileId);
    if (!row) throw notFound('File');
    deleteEnquiryFileRow(req.params.id, row.id);
    deleteFile(row.file_name);
    auditEvent(req, { update: `Enquiry ${req.params.id}: ${row.original_name} removed`, reference: 'Updated', module: 'Documents DMS' });
    res.json({ ok: true });
}));

/** GET /api/v1/enquiry-files/:enquiryId/:fileId?exp=&sig= (public, signed, expiring) */
adminRouter.get('/enquiry-files/:enquiryId/:fileId', (req, res) => {
    const { enquiryId, fileId } = req.params;
    if (!verifyMediaSignature(enquiryId, fileId, req.query.exp, req.query.sig, 'enquiry')) {
        return res.status(403).json({ detail: 'This link has expired. Reload the page.' });
    }
    const row = findEnquiryFileRow(enquiryId, fileId);
    const abs = row && filePath(row.file_name);
    if (!abs) return res.status(404).json({ detail: 'File not found.' });
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', `inline; filename="${row.original_name.replace(/[^\x20-\x7E]|["\\]/g, '_')}"`);
    return res.type(row.mime).sendFile(abs);
});

/** PATCH /api/v1/enquiries/:id { status?, notes? } -- follow-up. */
adminRouter.patch('/enquiries/:id', authenticate, asyncHandler(async (req, res) => {
    const current = findEnquiry(req.params.id);
    if (!current) throw notFound('Enquiry');
    const body = validate(req.body, {
        status: { oneOf: ENQUIRY_STATUSES, label: 'Status' },
        notes: { max: 4000, label: 'Notes' },
    }, { partial: true });
    const updated = updateEnquiry(current.id, { status: body.status ?? undefined, notes: 'notes' in body ? body.notes : undefined, handledBy: req.admin.name });
    if (body.status && body.status !== current.status) {
        auditEvent(req, { update: `Enquiry ${current.id}: ${current.status} -> ${body.status}`, reference: 'Updated', module: 'Enquiries' });
    }
    res.json(updated);
}));

/** DELETE /api/v1/enquiries/:id -- e.g. spam. */
adminRouter.delete('/enquiries/:id', authenticate, asyncHandler(async (req, res) => {
    const files = enquiryFileNames(req.params.id);
    if (!deleteEnquiry(req.params.id)) throw notFound('Enquiry');
    files.forEach(deleteFile);
    auditEvent(req, { update: `Enquiry ${req.params.id} deleted`, reference: 'Updated', module: 'Enquiries' });
    res.json({ ok: true });
}));
