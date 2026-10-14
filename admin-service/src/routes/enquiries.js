import { Router } from 'express';
import { asyncHandler, validate, notFound } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import {
    ENQUIRY_ORG_TYPES, ENQUIRY_INTERESTS, ENQUIRY_STATUSES, ENQUIRY_PHONE_RE, ENQUIRY_EMAIL_RE,
} from '../constants.js';
import { listEnquiries, findEnquiry, insertEnquiry, updateEnquiry, deleteEnquiry } from '../models/enquiryModel.js';
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

adminRouter.get('/enquiries/:id', authenticate, (req, res) => {
    const e = findEnquiry(req.params.id);
    if (!e) throw notFound('Enquiry');
    res.json(e);
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
    if (!deleteEnquiry(req.params.id)) throw notFound('Enquiry');
    auditEvent(req, { update: `Enquiry ${req.params.id} deleted`, reference: 'Updated', module: 'Enquiries' });
    res.json({ ok: true });
}));
