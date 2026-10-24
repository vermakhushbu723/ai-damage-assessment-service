import express, { Router } from 'express';
import { db, nowIso, parseJson, transaction } from '../db/database.js';
import { settings } from '../config.js';
import { badRequest, conflict, notFound } from '../utils/http.js';
import { DOC_TYPES, UPLOAD_MIME, VIDEO_MIME } from '../constants.js';
import { setClaimFields, audit, addEvent } from '../models/claimModel.js';
import { insertCommunication } from '../models/communicationModel.js';
import { storeDocument, uploadName } from './documents.js';
import { fmtDate, fmtDateTime } from '../utils/format.js';

// The customer's survey web link (ibimaassist.online/claim-weblink/...).
// No sign-in: the link token is the key. The page reads the intimation
// details entered by the call center, uploads every document / photo /
// video straight into the claim's Documents DMS, then submits the survey.

const router = Router();

/** The survey uploads -- shown under "Uploaded By" in the DMS. */
const CUSTOMER = { id: 'survey-link', name: 'Customer (Survey Link)' };
const MAX_VIDEO_MB = 100;

function claimForToken(token) {
    const t = String(token ?? '');
    if (!/^[A-Za-z0-9_-]{10,60}$/.test(t)) throw notFound('Survey link');
    const row = db.prepare("SELECT * FROM claims WHERE json_extract(link, '$.token') = ?").get(t);
    if (!row) throw notFound('Survey link');
    return row;
}

function assertOpen(row) {
    if (row.status === 'Closed') throw conflict('This claim is closed; the survey link no longer accepts uploads.');
    if (parseJson(row.link, {}).survey?.submittedAt) throw conflict('This survey is already submitted.');
}

const join = (...parts) => parts.filter(Boolean).join(', ') || null;
// The intimation form stores dates as ISO timestamps; the survey page shows them.
const isIso = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v);
const day = (v) => (isIso(v) ? fmtDate(v) : v ?? null);
const time = (v) => (isIso(v) ? fmtDateTime(v).split(', ')[1] : v ?? null);
const year = (v) => (isIso(v) ? fmtDate(v).slice(-4) : v ?? null);

/** GET /api/v1/survey/:token -- the intimation details the survey page shows. */
router.get('/survey/:token', (req, res) => {
    const row = claimForToken(req.params.token);
    const i = parseJson(row.intimation, {});
    const link = parseJson(row.link, {});
    const files = db.prepare('SELECT doc_type AS type, COUNT(*) AS n FROM documents WHERE claim_id = ? AND replaced_at IS NULL GROUP BY doc_type').all(row.id);
    res.json({
        assistClaimId: row.id,
        claimNo: row.claim_no,
        status: row.status,
        submittedAt: link.survey?.submittedAt ?? null,
        insurer: { name: i.insurerName ?? null, claimNumber: i.insurerClaimNumber ?? null, policyNumber: i.policyNumber ?? null, policyType: i.policyType ?? null, product: i.product ?? null },
        insured: { name: i.insuredName ?? null, mobile: i.insuredContact ?? null, email: i.insuredEmail ?? null, address: i.insuredAddress ?? null },
        vehicle: {
            registrationNumber: i.registrationNumber ?? row.vehicle_no ?? null,
            registrationDate: day(i.registrationDate),
            make: i.make ?? null,
            model: i.model ?? null,
            variant: i.variant ?? null,
            fuelType: i.fuelType ?? null,
            engineNo: i.engineNo ?? null,
            chassisNumber: i.chassisNumber ?? null,
            colour: i.colour ?? null,
            manufacturingYear: year(i.manufacturingYear),
            state: i.incidentState ?? null,
        },
        incident: {
            date: day(i.dateOfIncident),
            time: time(i.timeOfIncident),
            place: join(i.incidentArea, i.incidentLandmark, i.incidentCity, i.incidentState, i.incidentPincode),
            natureOfLoss: i.natureOfLoss ?? null,
            description: i.briefDescription ?? null,
        },
        driver: { name: i.driverName ?? null, licenseNumber: i.drivingLicenseNumber ?? null },
        workshop: { name: i.workshopName ?? null, contact: i.workshopContactNumber ?? null, address: join(i.workshopAddress, i.workshopCity) },
        uploaded: Object.fromEntries(files.map((f) => [f.type, f.n])),
    });
});

/**
 * PUT /api/v1/survey/:token/files/:type -- raw file body (Content-Type = its
 * type, X-File-Name = its name). Lands in the claim's Documents DMS.
 */
router.put(
    '/survey/:token/files/:type',
    express.raw({ type: () => true, limit: `${Math.max(settings.maxUploadMb, MAX_VIDEO_MB)}mb` }),
    (req, res) => {
        const row = claimForToken(req.params.token);
        assertOpen(row);
        const type = req.params.type;
        if (!DOC_TYPES[type]) throw badRequest('Unknown document type.');
        const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const video = type === 'survey-video';
        if (video ? !VIDEO_MIME[mime] : !UPLOAD_MIME[mime]) throw badRequest(video ? 'The walk-around video must be WEBM, MP4 or MOV.' : 'Only JPG, PNG, WEBP or PDF files can be uploaded.');
        if (type === 'vehicle-photos' && mime === 'application/pdf') throw badRequest('Vehicle photos must be images.');
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || !buf.length) throw badRequest('The file is empty.');
        if (!video && buf.length > settings.maxUploadMb * 1024 * 1024) throw badRequest(`File is too large (max ${settings.maxUploadMb} MB).`);
        const document = storeDocument(row.id, type, { buf, mime, name: uploadName(req) }, CUSTOMER, { sameNameOnly: true });
        res.status(201).json({ document: { id: document.id, type: document.type, name: document.name, size: document.size } });
    },
);

const text = (v, max = 200) => (v == null ? null : String(v).trim().slice(0, max) || null);

/**
 * POST /api/v1/survey/:token/submit { owner, inspection, recommendation }
 * Closes the link: the call center sees "Survey Submitted" in Communication
 * History and every uploaded file in the DMS.
 */
router.post('/survey/:token/submit', (req, res) => {
    const row = claimForToken(req.params.token);
    assertOpen(row);
    const body = req.body ?? {};
    const owner = Object.fromEntries(Object.entries(body.owner ?? {}).slice(0, 30).map(([k, v]) => [k.slice(0, 40), text(v)]));
    const inspection = Object.fromEntries(Object.entries(body.inspection ?? {}).slice(0, 30).map(([k, v]) => [k.slice(0, 40), text(v)]));
    const fileCount = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE claim_id = ? AND uploaded_by = ? AND replaced_at IS NULL").get(row.id, CUSTOMER.id).n;
    if (!fileCount) throw badRequest('Upload the vehicle photos before submitting the survey.');
    const at = nowIso();
    const link = parseJson(row.link, {});
    link.survey = { submittedAt: at, owner, inspection, recommendation: text(body.recommendation, 40), fileCount };
    transaction(() => {
        setClaimFields(row.id, { link: JSON.stringify(link) });
        insertCommunication(row.id, {
            direction: 'received',
            type: 'Survey Submitted',
            tag: 'Survey Link',
            reference: `Files: ${fileCount}`,
            description: `Vehicle survey submitted through the survey link (${fileCount} file${fileCount === 1 ? '' : 's'} added to Documents DMS).`,
            person: owner.ownerName || 'Customer',
            personMeta: '(Survey Link)',
            channel: 'Portal',
            recipient: null,
            status: 'Received',
            at,
        });
        addEvent(row.id, { kind: 'survey', action: 'Survey Submitted', detail: `${fileCount} file(s) uploaded`, data: link.survey, actor: CUSTOMER });
        audit(row.id, 'Survey submitted', `Survey link · ${fileCount} file(s)`, CUSTOMER);
    });
    res.json({ ok: true, claimNo: row.claim_no, fileCount, submittedAt: at });
});

export default router;
