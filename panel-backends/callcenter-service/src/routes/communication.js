import { Router } from 'express';
import { db, nowIso, parseJson, transaction } from '../db/database.js';
import { asyncHandler, badRequest, notFound, normalizePhone, isEmail } from '../utils/http.js';
import { authenticate, can, actorOf } from '../middleware/authenticate.js';
import {
    MODULES, LETTER_TYPES, REQUESTING_ON, LETTER_PRIORITIES, LETTER_REASONS, LETTER_CHANNELS, REMARKS_LIMIT, INSTRUCTIONS_LIMIT,
} from '../constants.js';
import { findClaimRow, audit } from '../models/claimModel.js';
import { insertCommunication, listCommunications, findCommunication, closeAwaiting } from '../models/communicationModel.js';
import { dispatch, gatewayConfigured } from '../services/notifier.js';
import { flush } from '../services/sync.js';
import { signedFileUrl } from '../services/fileStore.js';
import { nextDailyId } from '../utils/ids.js';
import { sendPdf } from '../utils/pdf.js';
import { fmtDate, fmtDateTime, csvCell } from '../utils/format.js';
import { loadClaim } from './claims.js';

// Issue Letter + Communication History (both communication screens).

const router = Router();
router.use(authenticate);

// ======================= letters =======================

const LETTER_META = {
    title: 'LETTER FOR INFORMATION / DOCUMENTS REQUIRED',
    team: 'Claims Team',
    sender: 'Ibima Assist',
    footNote: 'This is a system generated letter. No signature is required.',
};

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '') && !Number.isNaN(Date.parse(s));

function cleanLetter(body) {
    const f = body.form ?? {};
    if (!LETTER_TYPES[f.letterType]) throw badRequest('Choose the letter type.');
    if (!REQUESTING_ON[f.requestingOn]) throw badRequest('Choose "Requesting On".');
    if (!LETTER_PRIORITIES.includes(f.priority)) throw badRequest('Choose the priority.');
    if (!LETTER_REASONS[f.reason]) throw badRequest('Select the reason for the letter.');
    if (!isDay(f.issueDate) || !isDay(f.responseDueBy)) throw badRequest('Issue date and response date must be YYYY-MM-DD.');
    if (f.responseDueBy < f.issueDate) throw badRequest('"Response Due By" cannot be before the issue date.');
    const remarks = String(f.remarks ?? '').trim();
    const instructions = String(f.instructions ?? '').trim();
    if (remarks.length > REMARKS_LIMIT) throw badRequest(`Remarks: at most ${REMARKS_LIMIT} characters.`);
    if (instructions.length > INSTRUCTIONS_LIMIT) throw badRequest(`Instructions: at most ${INSTRUCTIONS_LIMIT} characters.`);
    const requirements = (Array.isArray(body.requirements) ? body.requirements : [])
        .filter((r) => r && typeof r.label === 'string' && r.label.trim())
        .slice(0, 40)
        .map((r) => ({ label: r.label.trim().slice(0, 150), checked: !!r.checked }));
    const items = requirements.filter((r) => r.checked).map((r) => r.label);
    if (!items.length) throw badRequest('Select at least one document / detail to request.');
    return { form: { ...f, remarks, instructions }, requirements, items };
}

/** Letter body -- same wording as the portal's preview (src/data/letterData.js buildLetterBody). */
function letterBody(row, { form, items }) {
    const i = parseJson(row.intimation, {});
    const reported = fmtDate(row.submitted_at ?? i.intimationDateTime ?? row.created_at);
    return {
        subject: `${LETTER_REASONS[form.reason]} – Information Requested`,
        intro: `This is in reference to the motor claim intimation (Claim ID: ${row.claim_no}) reported on ${reported}.`,
        lead: form.letterType === 'documents-required'
            ? 'In order to process your claim further, please provide the following documents:'
            : 'As per the information provided, the vehicle is not available at any workshop. In order to process your claim further, please provide the following information / documents:',
        items,
        deadline: fmtDate(form.responseDueBy),
        warning: 'Failure to provide the requested information may lead to delay in claim processing.',
        queries: 'For any queries, please contact us.',
    };
}

function letterPdfBlocks(row, letterNo, data) {
    const b = data.body;
    return [
        { text: 'IBIMA ASSIST', size: 13, bold: true },
        { text: 'Claims Management', size: 8 },
        { cols: [`Letter No.: ${letterNo}`, `Date: ${fmtDate(data.form.issueDate)}`], size: 9, gap: 6 },
        { text: LETTER_META.title, size: 11, bold: true, align: 'center', gap: 10 },
        { text: 'To,', gap: 10 }, { text: row.insured_name ?? '' }, { text: row.vehicle_no ?? '' },
        { text: `Subject: ${b.subject}`, bold: true, gap: 10 },
        { text: 'Dear Sir/Madam,', gap: 8 }, { text: b.intro, gap: 4 }, { text: b.lead, gap: 4 },
        ...b.items.map((it, n) => ({ text: `${n + 1}. ${it}` })),
        { text: `Please share the above information on or before ${b.deadline}.`, gap: 6 },
        { text: b.warning, gap: 4 },
        ...(data.form.instructions ? [{ text: data.form.instructions, gap: 4 }] : []),
        { text: b.queries, gap: 4 },
        { text: 'Thank you,', gap: 10 }, { text: LETTER_META.team }, { text: LETTER_META.sender, bold: true },
        { text: LETTER_META.footNote, size: 8, gap: 14 },
    ];
}

const toLetter = (l) => {
    const d = parseJson(l.data, {});
    return { id: l.id, letterType: LETTER_TYPES[d.form?.letterType] ?? d.form?.letterType, channel: l.channel, issueDate: d.form?.issueDate, responseDueBy: d.form?.responseDueBy, items: d.body?.items ?? [], status: d.status, createdBy: l.created_by_name, createdAt: l.created_at };
};

/** GET /api/v1/claims/:id/letters -- history, next letter no, contact defaults. */
router.get('/claims/:id/letters', can(MODULES.letters), (req, res) => {
    const row = loadClaim(req);
    const i = parseJson(row.intimation, {});
    res.json({
        history: db.prepare('SELECT * FROM letters WHERE claim_id = ? ORDER BY created_at DESC').all(row.id).map(toLetter),
        nextLetterNo: nextDailyId('letters', 'LET'),
        contact: { mobile: row.mobile ?? i.insuredContact ?? '', email: i.insuredEmail ?? '' },
        gatewayConfigured: gatewayConfigured(),
        meta: LETTER_META,
    });
});

/** POST /api/v1/claims/:id/letters/preview.pdf { form, requirements } -- "Download" before generating. */
router.post('/claims/:id/letters/preview.pdf', can(MODULES.letters), (req, res) => {
    const row = loadClaim(req);
    const clean = cleanLetter(req.body ?? {});
    sendPdf(res, `Letter-${row.claim_no}-draft.pdf`, letterPdfBlocks(row, `${nextDailyId('letters', 'LET')} (draft)`, { ...clean, body: letterBody(row, clean) }));
});

/**
 * POST /api/v1/claims/:id/letters { form, requirements, channel, contact } -- "Generate Letter":
 * issues the letter, sends it on the chosen channel and logs it.
 */
router.post('/claims/:id/letters', can(MODULES.letters, 'create'), asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    if (row.status === 'Draft') throw badRequest('Submit the intimation first.');
    const clean = cleanLetter(req.body ?? {});
    const channel = LETTER_CHANNELS[req.body?.channel];
    if (!channel) throw badRequest('Choose how the letter is sent.');
    const mobile = normalizePhone(req.body?.contact?.mobile);
    const email = String(req.body?.contact?.email ?? '').trim();
    if (channel === 'Email' && !isEmail(email)) throw badRequest('Enter a valid email ID.');
    if (channel !== 'Email' && !mobile) throw badRequest('Enter a valid 10-digit mobile number.');
    const body = letterBody(row, clean);
    const to = channel === 'Email' ? email : mobile;
    const letterNo = nextDailyId('letters', 'LET');
    const outcome = await dispatch({
        channel, to, subject: `${LETTER_META.title} · ${letterNo}`,
        message: [body.intro, body.lead, ...body.items.map((x, n) => `${n + 1}. ${x}`), `Please respond by ${body.deadline}.`].join('\n'),
        claimNo: row.claim_no, reference: letterNo,
    });
    const actor = actorOf(req);
    transaction(() => {
        db.prepare('INSERT INTO letters (id, claim_id, data, channel, created_by, created_by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(letterNo, row.id, JSON.stringify({ ...clean, body, contact: { mobile, email }, status: outcome.status }), channel, actor.id, actor.name, nowIso());
        insertCommunication(row.id, {
            direction: 'sent',
            type: 'Letter Sent',
            tag: `${LETTER_TYPES[clean.form.letterType]} Letter`,
            reference: `Letter No.: ${letterNo}`,
            description: LETTER_REASONS[clean.form.reason],
            subDescription: outcome.error ?? 'Requested documents / details:',
            bullets: body.items,
            person: 'Ibima Assist',
            personMeta: `(${actor.name})`,
            channel,
            recipient: to,
            status: outcome.status,
            awaitingResponse: outcome.status !== 'Failed',
            responseDue: clean.form.responseDueBy,
            letterId: letterNo,
            createdBy: actor.id,
        });
        audit(row.id, 'Letter issued', `${letterNo} · ${channel}: ${outcome.status}`, actor);
    });
    flush().catch(() => {});
    res.status(201).json({ letter: toLetter(db.prepare('SELECT * FROM letters WHERE id = ?').get(letterNo)), delivery: outcome });
}));

/** GET /api/v1/claims/:id/letters/:letterId/pdf */
router.get('/claims/:id/letters/:letterId/pdf', can(MODULES.letters), (req, res) => {
    const row = loadClaim(req);
    const l = db.prepare('SELECT * FROM letters WHERE id = ? AND claim_id = ?').get(req.params.letterId, row.id);
    if (!l) throw notFound('Letter');
    sendPdf(res, `${l.id}.pdf`, letterPdfBlocks(row, l.id, parseJson(l.data, {})));
});

// ======================= communication history =======================

function withAttachment(c) {
    if (!c.attachmentId) return c;
    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(c.attachmentId);
    return d ? { ...c, attachment: { id: d.id, name: d.file_name, size: d.size, url: signedFileUrl(d.id) } } : c;
}

function communicationState(row) {
    const rows = listCommunications(row.id).map(withAttachment);
    const sent = rows.filter((r) => r.direction === 'sent').length;
    const received = rows.filter((r) => r.direction === 'received').length;
    const pending = rows.filter((r) => r.awaitingResponse).length;
    return {
        rows,
        counts: { all: rows.length, sent, received, pending },
        lastCommunication: rows[0]?.at ?? null,
        gatewayConfigured: gatewayConfigured(),
    };
}

router.get('/claims/:id/communications', can(MODULES.communication), (req, res) => res.json(communicationState(loadClaim(req))));

/**
 * POST /api/v1/claims/:id/communications -- Quick Actions.
 * { kind: 'email', to, subject, message } | { kind: 'sms', to, message }
 * | { kind: 'note', message } | { kind: 'response', from, fromRole, channel, message, replyTo? }
 */
router.post('/claims/:id/communications', can(MODULES.communication, 'create'), asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    const b = req.body ?? {};
    const message = String(b.message ?? '').trim();
    if (!message) throw badRequest('Write the message first.');
    if (message.length > 2000) throw badRequest('Message must be at most 2000 characters.');
    const actor = actorOf(req);
    const base = { createdBy: actor.id, person: 'Ibima Assist', personMeta: `(${actor.name})` };
    let entry;
    if (b.kind === 'email' || b.kind === 'sms') {
        const channel = b.kind === 'email' ? 'Email' : 'SMS';
        const to = b.kind === 'email' ? String(b.to ?? '').trim() : normalizePhone(b.to);
        if (b.kind === 'email' && !isEmail(to)) throw badRequest('Enter a valid email address.');
        if (b.kind === 'sms' && !to) throw badRequest('Enter a valid 10-digit mobile number.');
        const subject = String(b.subject ?? '').trim().slice(0, 150);
        const outcome = await dispatch({ channel, to, subject: subject || `Claim ${row.claim_no}`, message, claimNo: row.claim_no, reference: null });
        entry = {
            ...base, direction: 'sent', type: `${channel} Sent`, tag: subject || `${channel} To Customer`, description: message,
            subDescription: outcome.error ?? null, channel, recipient: to, status: outcome.status, awaitingResponse: !!b.awaitResponse,
        };
    } else if (b.kind === 'note') {
        entry = { ...base, direction: 'note', type: 'Note Added', tag: 'Internal Note', description: message, channel: 'Portal', status: 'Noted' };
    } else if (b.kind === 'response') {
        const from = String(b.from ?? '').trim().slice(0, 80);
        if (!from) throw badRequest('Who responded?');
        const replyTo = b.replyTo ? findCommunication(row.id, b.replyTo) : null;
        if (b.replyTo && !replyTo) throw badRequest('The communication being answered does not exist.');
        entry = {
            createdBy: actor.id, direction: 'received', type: 'Response Received', tag: `${String(b.fromRole ?? 'Customer').slice(0, 40)} Response`,
            reference: replyTo?.letterId ? `Re: ${replyTo.letterId}` : replyTo ? `Re: ${replyTo.tag}` : null,
            description: message, person: from, personMeta: b.fromRole ? `(${String(b.fromRole).slice(0, 40)})` : null,
            channel: ['Email', 'SMS', 'WhatsApp', 'Phone', 'Portal'].includes(b.channel) ? b.channel : 'Phone', status: 'Received',
        };
        if (b.attachmentId) {
            const d = db.prepare('SELECT id FROM documents WHERE id = ? AND claim_id = ?').get(b.attachmentId, row.id);
            if (!d) throw badRequest('Attachment not found in this claim\'s documents.');
            entry.attachmentId = d.id;
        }
        if (replyTo) closeAwaiting(row.id, replyTo.id);
    } else {
        throw badRequest("kind must be 'email', 'sms', 'note' or 'response'.");
    }
    transaction(() => {
        insertCommunication(row.id, entry);
        audit(row.id, entry.type, entry.tag, actor);
    });
    flush().catch(() => {});
    res.status(201).json(communicationState(findClaimRow(row.id)));
}));

/** GET /api/v1/claims/:id/communications/export.csv -- "Export History". */
router.get('/claims/:id/communications/export.csv', can(MODULES.communication, 'download'), (req, res) => {
    const row = loadClaim(req);
    const head = ['Date & Time', 'Direction', 'Type', 'Tag', 'Reference', 'Description', 'Details', 'By', 'Channel', 'To', 'Status'];
    const lines = listCommunications(row.id).map((c) => [
        fmtDateTime(c.at), c.direction, c.type, c.tag, c.reference, c.description, [c.subDescription, ...(c.bullets ?? [])].filter(Boolean).join('; '),
        `${c.person} ${c.personMeta ?? ''}`.trim(), c.channel, c.recipient, c.status,
    ].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Communication-${row.claim_no}.csv"`);
    res.end([head.join(','), ...lines].join('\n'));
});

export default router;
