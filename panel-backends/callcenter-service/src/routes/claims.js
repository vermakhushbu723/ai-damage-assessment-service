import { Router } from 'express';
import { db, nowIso, parseJson, transaction } from '../db/database.js';
import { settings } from '../config.js';
import { asyncHandler, badRequest, notFound, conflict, normalizePhone, isEmail } from '../utils/http.js';
import { authenticate, can, actorOf, allowed } from '../middleware/authenticate.js';
import {
    MODULES, INTIMATION_REQUIRED, LINK_RECIPIENTS, LINK_CHANNELS, PRIORITIES, SOURCES, STAGE_KEYS, COMPLETED,
} from '../constants.js';
import {
    nextClaimIds, insertClaim, updateIntimation, findClaimRow, setClaimFields, toClaim, toListItem, completeStage, audit,
    addEvent, listEvents, getDoc, putDoc,
} from '../models/claimModel.js';
import { insertCommunication } from '../models/communicationModel.js';
import { adminClaim } from '../services/adminClient.js';
import { syncClaim, flush } from '../services/sync.js';
import { dispatch } from '../services/notifier.js';
import { randomToken } from '../utils/ids.js';

const router = Router();
router.use(authenticate);

const HOUR = 3600_000;
const RANGES = { '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': 30 * 24 * HOUR };
const RANGE_LABEL = { '24h': 'VS Yesterday', '7d': 'VS Previous 7 Days', '30d': 'VS Previous 30 Days' };

/** The claim, or 404. Drafts are visible to their creator only. */
export function loadClaim(req) {
    const row = findClaimRow(req.params.id);
    if (!row || (row.status === 'Draft' && row.created_by !== req.user.id)) throw notFound('Claim');
    return row;
}

// ---------- dashboard ----------

const countSince = (from, to, extra = '', params = []) =>
    db.prepare(`SELECT COUNT(*) AS n FROM claims WHERE submitted_at >= ? AND submitted_at < ? ${extra}`).get(from, to, ...params).n;

function trend(now, prev, label) {
    if (!prev) return { direction: now ? 'up' : 'flat', value: now ? `+${now}` : '0', label };
    const pct = ((now - prev) / prev) * 100;
    return { direction: pct < 0 ? 'down' : 'up', value: `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`, label };
}

function pageOf(rows, page, pageSize) {
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    const p = Math.min(Math.max(1, page), totalPages);
    return { rows: rows.slice((p - 1) * pageSize, p * pageSize), page: p, totalPages, total: rows.length };
}

/** "22h 15m" left on the allocation SLA, or "Overdue 3h". */
function tatLeft(submittedAt) {
    const left = settings.slaHours * 60 - Math.round((Date.now() - new Date(submittedAt).getTime()) / 60000);
    const fmt = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
    return left >= 0 ? fmt(left) : `Overdue ${fmt(-left)}`;
}

/**
 * GET /api/v1/dashboard?range=24h|7d|30d&all=1&priority=&source=&page=&allocationPage=
 * KPI tiles + "New Intimations" + "Pending Allocation".
 */
router.get('/dashboard', can(MODULES.dashboard), (req, res) => {
    const range = RANGES[req.query.range] ? req.query.range : '24h';
    const span = RANGES[range];
    const now = Date.now();
    const iso = (t) => new Date(t).toISOString();
    const [from, prevFrom, to] = [iso(now - span), iso(now - 2 * span), iso(now + 60_000)];
    const month = RANGES['30d'];

    const pendingNow = db.prepare("SELECT COUNT(*) AS n FROM claims WHERE status = 'Open' AND handler_id IS NULL").get().n;
    const linkCount = (a, b) => db.prepare("SELECT COUNT(*) AS n FROM communications WHERE tag = 'Survey Link' AND at >= ? AND at < ?").get(a, b).n;
    const noHandler = 'AND handler_id IS NULL';

    const stats = {
        totalIntimation: {
            value: db.prepare('SELECT COUNT(*) AS n FROM claims WHERE submitted_at IS NOT NULL').get().n,
            trend: trend(countSince(iso(now - month), to), countSince(iso(now - 2 * month), iso(now - month)), 'VS Last 30 Days'),
        },
        newIntimations: { value: countSince(from, to), trend: trend(countSince(from, to), countSince(prevFrom, from), RANGE_LABEL[range]) },
        pendingAllocation: { value: pendingNow, trend: trend(countSince(from, to, noHandler), countSince(prevFrom, from, noHandler), RANGE_LABEL[range]) },
        linkSent: {
            value: db.prepare("SELECT COUNT(*) AS n FROM communications WHERE tag = 'Survey Link'").get().n,
            trend: trend(linkCount(from, to), linkCount(prevFrom, from), RANGE_LABEL[range]),
        },
    };

    // New intimations: submitted in the range (or all), plus my own drafts on top.
    const filters = [];
    const params = [];
    if (req.query.all !== '1' && !isDay(req.query.from)) {
        filters.push('submitted_at >= ?');
        params.push(from);
    }
    if (PRIORITIES.includes(req.query.priority)) {
        filters.push('priority = ?');
        params.push(req.query.priority);
    }
    if (SOURCES.includes(req.query.source)) {
        filters.push('source = ?');
        params.push(req.query.source);
    }
    // Quick Filters: date range, location (city), insurer.
    if (isDay(req.query.from)) {
        filters.push('submitted_at >= ?');
        params.push(new Date(`${req.query.from}T00:00:00+05:30`).toISOString());
    }
    if (isDay(req.query.to)) {
        filters.push('submitted_at < ?');
        params.push(new Date(new Date(`${req.query.to}T00:00:00+05:30`).getTime() + 86400_000).toISOString());
    }
    if (req.query.location) {
        filters.push('city = ?');
        params.push(String(req.query.location));
    }
    if (req.query.insurer) {
        filters.push("json_extract(intimation, '$.insurerName') = ?");
        params.push(String(req.query.insurer));
    }
    const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
    const drafts = allowed(req.user, MODULES.intimation, 'view')
        ? db.prepare("SELECT * FROM claims WHERE status = 'Draft' AND created_by = ? ORDER BY updated_at DESC").all(req.user.id)
        : [];
    const submitted = db.prepare(`SELECT * FROM claims WHERE submitted_at IS NOT NULL ${where} ORDER BY submitted_at DESC`).all(...params);
    const intimations = pageOf([...drafts, ...submitted].map(toListItem), Number(req.query.page) || 1, 7);

    const pending = db.prepare("SELECT * FROM claims WHERE status = 'Open' AND handler_id IS NULL ORDER BY submitted_at ASC").all()
        .map((r) => ({ ...toListItem(r), tatLeft: tatLeft(r.submitted_at) }));
    const allocation = pageOf(pending, Number(req.query.allocationPage) || 1, 5);

    res.json({ range, stats, intimations, allocation, filterOptions: filterOptions() });
});

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Values for the Quick Filters popup (what the data actually has). */
function filterOptions() {
    const distinct = (sql) => db.prepare(sql).all().map((r) => r.v).filter(Boolean);
    return {
        sources: SOURCES,
        priorities: PRIORITIES,
        locations: distinct("SELECT DISTINCT city AS v FROM claims WHERE submitted_at IS NOT NULL ORDER BY city"),
        insurers: distinct("SELECT DISTINCT json_extract(intimation, '$.insurerName') AS v FROM claims WHERE submitted_at IS NOT NULL ORDER BY v"),
    };
}

/** I-Bima Assist Unique ID: IBIMA-YYYY-NNNNNN, one running number per year. */
function nextUniqueId() {
    const year = new Date().getFullYear();
    const row = db.prepare("SELECT MAX(CAST(substr(json_extract(link, '$.uniqueId'), 12) AS INTEGER)) AS n FROM claims WHERE json_extract(link, '$.uniqueId') LIKE ?")
        .get(`IBIMA-${year}-%`);
    return `IBIMA-${year}-${String((row.n ?? 0) + 1).padStart(6, '0')}`;
}

/**
 * POST /api/v1/claims/:id/unique-id -- the refresh icon next to "I-Bima Assist
 * Unique ID": issues one if the claim has none, or a new one while the survey
 * link has not been sent yet.
 */
router.post('/claims/:id/unique-id', can(MODULES.intimation, 'edit'), (req, res) => {
    const row = loadClaim(req);
    const link = parseJson(row.link, {});
    if (link.uniqueId && link.sentAt) throw conflict('The survey link with this ID is already sent; the ID cannot change.');
    link.uniqueId = nextUniqueId();
    setClaimFields(row.id, { link: JSON.stringify(link) });
    audit(row.id, 'Unique ID issued', link.uniqueId, actorOf(req));
    res.json({ uniqueId: link.uniqueId, claim: toClaim(findClaimRow(row.id)) });
});

const DAY = 86400_000;
const istDay = (iso) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * GET /api/v1/dashboard/analytics?days=7|30 -- "Analyze Data": intimation
 * trend, status overview, sources and the survey link sent summary.
 */
router.get('/dashboard/analytics', can(MODULES.dashboard), (req, res) => {
    const days = [7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const subs = db.prepare('SELECT * FROM claims WHERE submitted_at IS NOT NULL').all();

    // Trend: intimations per day (IST), oldest first.
    const today = istDay(new Date().toISOString());
    const trend = Array.from({ length: days }, (_, i) => {
        const day = istDay(new Date(new Date(`${today}T12:00:00Z`).getTime() - (days - 1 - i) * DAY).toISOString());
        return { date: day, count: subs.filter((r) => istDay(r.submitted_at) === day).length };
    });

    const linkOf = (r) => parseJson(r.link, {});
    const total = subs.length;
    const pct = (n) => (total ? Math.round((n / total) * 1000) / 10 : 0);
    const status = [
        { key: 'new', label: 'New Intimation', value: subs.filter((r) => Date.now() - new Date(r.submitted_at).getTime() < DAY).length },
        { key: 'pending', label: 'Pending Allocation', value: subs.filter((r) => r.status === 'Open' && !r.handler_id).length },
        { key: 'link', label: 'Link Sent', value: subs.filter((r) => linkOf(r).sentAt).length },
        { key: 'allocated', label: 'Allocated', value: subs.filter((r) => r.handler_id).length },
    ].map((s) => ({ ...s, pct: pct(s.value) }));

    const sourceOf = (r) => {
        const i = parseJson(r.intimation, {});
        if (i.channelType === 'Email') return 'Email';
        if (r.source === 'App') return 'Mobile App';
        if (r.source === 'Website') return 'Website';
        if (r.source === 'Call Center') return 'Call Center';
        return 'Others';
    };
    const sources = ['Call Center', 'Website', 'Mobile App', 'Email', 'Others'].map((label) => {
        const value = subs.filter((r) => sourceOf(r) === label).length;
        return { key: label, label, value, pct: pct(value) };
    });

    // Survey links per day sent: opened (via /s/:token) and completed (vehicle photos uploaded after sending).
    const photosAfter = db.prepare("SELECT 1 FROM documents WHERE claim_id = ? AND doc_type = 'vehicle-photos' AND uploaded_at >= ? LIMIT 1");
    const byDay = new Map();
    for (const r of db.prepare('SELECT id, link FROM claims').all()) {
        const l = linkOf(r);
        if (!l.sentAt) continue;
        const day = istDay(l.sentAt);
        const e = byDay.get(day) ?? { date: day, sent: 0, accessed: 0, completed: 0 };
        e.sent += 1;
        if (l.accessedAt) e.accessed += 1;
        if (photosAfter.get(r.id, l.sentAt)) e.completed += 1;
        byDay.set(day, e);
    }
    const summary = [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date))
        .map((e) => ({ ...e, accessRate: e.sent ? Math.round((e.accessed / e.sent) * 100) : 0 }));
    const page = Math.max(1, Number(req.query.page) || 1);
    const totalPages = Math.max(1, Math.ceil(summary.length / 5));
    const p = Math.min(page, totalPages);

    res.json({
        days, total, trend, status, sources,
        linkSummary: { rows: summary.slice((p - 1) * 5, p * 5), page: p, totalPages, total: summary.length, tracking: !!settings.publicUrl },
    });
});

// ---------- claims ----------

/** GET /api/v1/claims?search=&stage=&status=&page=&pageSize= */
router.get('/claims', (req, res) => {
    const where = ["(status <> 'Draft' OR created_by = ?)"];
    const params = [req.user.id];
    const q = String(req.query.search ?? '').trim().toLowerCase();
    if (q) {
        where.push('(lower(id) LIKE ? OR lower(claim_no) LIKE ? OR lower(insured_name) LIKE ? OR lower(vehicle_no) LIKE ? OR mobile LIKE ? OR lower(policy_no) LIKE ?)');
        params.push(...Array(6).fill(`%${q}%`));
    }
    if ([...STAGE_KEYS, COMPLETED].includes(req.query.stage)) {
        where.push('stage = ?');
        params.push(req.query.stage);
    }
    if (['Draft', 'Open', 'Closed'].includes(req.query.status)) {
        where.push('status = ?');
        params.push(req.query.status);
    }
    const rows = db.prepare(`SELECT * FROM claims WHERE ${where.join(' AND ')} ORDER BY COALESCE(submitted_at, created_at) DESC`).all(...params);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    res.json(pageOf(rows.map(toListItem), Number(req.query.page) || 1, pageSize));
});

/** GET /api/v1/claims/next-id -- the Assist Claim ID the next new intimation will get. */
router.get('/claims/next-id', (_req, res) => res.json(nextClaimIds()));

/** Intimation form: an object of strings / string lists, under 60 KB. */
function cleanIntimation(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('intimation must be an object.');
    if (JSON.stringify(input).length > 60_000) throw badRequest('Intimation is too large.');
    const out = {};
    for (const [k, v] of Object.entries(input)) {
        if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k)) continue;
        if (v === null || v === undefined || v === '') continue;
        if (typeof v === 'string') out[k] = v.trim().slice(0, 2000);
        else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string').map((x) => x.slice(0, 100));
        else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    }
    for (const k of ['callerContact', 'insuredContact', 'workshopContactNumber']) {
        if (out[k]) {
            const p = normalizePhone(out[k]);
            if (!p) throw badRequest(`${k === 'workshopContactNumber' ? 'Workshop contact number' : k === 'callerContact' ? 'Caller contact number' : 'Insured contact number'} must be a valid 10-digit mobile number.`);
            out[k] = p;
        }
    }
    if (out.insuredEmail && !isEmail(out.insuredEmail)) throw badRequest('Insured email ID is not a valid email address.');
    if (out.intimationSource && !SOURCES.includes(out.intimationSource)) throw badRequest(`Intimation source must be one of: ${SOURCES.join(', ')}.`);
    if (out.registrationNumber) out.registrationNumber = out.registrationNumber.toUpperCase();
    return out;
}

function missingRequired(i) {
    return Object.entries(INTIMATION_REQUIRED).filter(([k]) => !i[k] || (Array.isArray(i[k]) && !i[k].length)).map(([, label]) => label);
}

/** GET /api/v1/claims/:id -- header + everything of the claim; `fraud` comes from the Admin portal. */
router.get('/claims/:id', asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    const claim = toClaim(row);
    let fraud = { available: false, count: 0, risk: null };
    if (row.status !== 'Draft') {
        try {
            const remote = await adminClaim(row.claim_no);
            const open = (remote?.triggers ?? []).filter((t) => t.status !== 'Cleared');
            const top = Math.max(0, ...open.map((t) => Number(t.score) || 0));
            fraud = {
                available: true,
                count: open.length,
                risk: !open.length ? 'Low' : top >= 50 ? 'Critical' : top >= 30 ? 'High' : top >= 15 ? 'Medium' : 'Low',
                triggers: open.map((t) => ({ id: t.id, trigger: t.trigger, score: t.score, status: t.status })),
                syncedToAdmin: !!remote,
            };
        } catch {
            /* Admin portal unreachable: header shows "—" */
        }
    }
    res.json({ ...claim, fraud });
}));

/** POST /api/v1/claims { intimation, link? } -- "Save Details": a new draft. */
router.post('/claims', can(MODULES.intimation, 'create'), (req, res) => {
    const intimation = cleanIntimation(req.body?.intimation ?? {});
    const actor = actorOf(req);
    const id = transaction(() => {
        const newId = insertClaim(intimation, actor);
        setClaimFields(newId, { link: JSON.stringify({ ...cleanLinkSettings(req.body?.link ?? {}), uniqueId: nextUniqueId() }) });
        audit(newId, 'Draft saved', 'Intimation saved as draft', actor);
        return newId;
    });
    res.status(201).json(toClaim(findClaimRow(id)));
});

/** PATCH /api/v1/claims/:id { intimation?, link? } -- "Save Details" again / Auto Reminder switch. */
router.patch('/claims/:id', can(MODULES.intimation, 'edit'), (req, res) => {
    const row = loadClaim(req);
    const actor = actorOf(req);
    transaction(() => {
        if (req.body?.intimation) {
            const next = cleanIntimation(req.body.intimation);
            if (row.status !== 'Draft') {
                const missing = missingRequired(next);
                if (missing.length) throw badRequest(`${missing[0]} is required.`, { missing });
            }
            updateIntimation(row.id, next);
            audit(row.id, row.status === 'Draft' ? 'Draft saved' : 'Intimation updated', null, actor);
        }
        if (req.body?.link) {
            const link = { ...parseJson(row.link, {}), ...cleanLinkSettings(req.body.link) };
            setClaimFields(row.id, { link: JSON.stringify(link) });
        }
    });
    if (row.status !== 'Draft') syncClaim(row.id).catch(() => {});
    res.json(toClaim(findClaimRow(row.id)));
});

/**
 * POST /api/v1/claims/:id/submit { intimation? } -- "Submit Details". The claim
 * goes to the Admin portal, whose allocation rule picks the handler.
 */
router.post('/claims/:id/submit', can(MODULES.intimation, 'create'), asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    if (row.status !== 'Draft') throw conflict('This intimation is already submitted.');
    const intimation = req.body?.intimation ? cleanIntimation(req.body.intimation) : parseJson(row.intimation, {});
    const missing = missingRequired(intimation);
    if (missing.length) throw badRequest(`${missing[0]} is required.`, { missing });
    const actor = actorOf(req);
    transaction(() => {
        updateIntimation(row.id, intimation);
        setClaimFields(row.id, { status: 'Open', submitted_at: nowIso() });
        completeStage(row.id, 'intimation', actor);
        audit(row.id, 'Intimation submitted', `Claim ${row.claim_no} registered`, actor);
    });
    const sync = await syncClaim(row.id);
    res.json({ ...toClaim(findClaimRow(row.id)), sync: { pushedToAdmin: !sync.error, error: sync.error ?? null } });
}));

/** POST /api/v1/claims/sync -- push anything still queued for the Admin portal (also runs every minute). */
router.post('/claims/sync', asyncHandler(async (_req, res) => res.json(await flush())));

// ---------- survey link (Intimation "Link" block) ----------

function cleanLinkSettings(input) {
    const out = {};
    const list = (v, allowedValues) => (Array.isArray(v) ? v.filter((x) => allowedValues.includes(x)) : []);
    if ('vehicleAtWorkshop' in input) out.vehicleAtWorkshop = list(input.vehicleAtWorkshop, ['Yes', 'No']);
    if ('letterDispatch' in input) out.letterDispatch = list(input.letterDispatch, ['Issue Letters']);
    if ('dispatchType' in input) out.dispatchType = list(input.dispatchType, ['Send Survey Link']);
    if ('recipients' in input) out.recipients = list(input.recipients, LINK_RECIPIENTS);
    if ('sendVia' in input) out.sendVia = list(input.sendVia, LINK_CHANNELS);
    if ('mobile' in input) out.mobile = String(input.mobile ?? '').trim().slice(0, 20);
    if ('email' in input) out.email = String(input.email ?? '').trim().slice(0, 120);
    if ('autoReminder' in input) out.autoReminder = !!input.autoReminder;
    return out;
}

/**
 * POST /api/v1/claims/:id/survey-link { recipients, sendVia, mobile, email, autoReminder }
 * Generates the claim's survey link (once) and sends it on every chosen
 * channel; each message is a Communication History row.
 */
router.post('/claims/:id/survey-link', can(MODULES.intimation, 'edit'), asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    const input = cleanLinkSettings(req.body ?? {});
    const link = { ...parseJson(row.link, {}), ...input };
    const via = link.sendVia?.includes('All') ? ['SMS', 'Whats App', 'Email'] : (link.sendVia ?? []);
    if (!via.length) throw badRequest('Choose at least one "Send Via" channel.');
    if (!link.recipients?.length) throw badRequest('Choose the survey link recipient.');
    const mobile = normalizePhone(link.mobile);
    if (via.some((c) => c !== 'Email') && !mobile) throw badRequest('Enter a valid 10-digit recipient mobile number.');
    if (via.includes('Email') && !isEmail(link.email)) throw badRequest('Enter a valid recipient email.');

    link.token = link.token ?? randomToken(18);
    link.url = settings.publicUrl
        ? `${settings.publicUrl}/api/v1/s/${encodeURIComponent(link.token)}`
        : `${settings.surveyLinkBase}?token=${encodeURIComponent(link.token)}`;
    const recipientLabel = link.recipients.includes('Both') ? 'Insured & Workshop' : link.recipients.join(' & ');
    const actor = actorOf(req);
    const i = parseJson(row.intimation, {});

    const results = [];
    for (const channel of via) {
        const to = channel === 'Email' ? link.email : mobile;
        const outcome = await dispatch({
            channel,
            to,
            subject: `Survey link for claim ${row.claim_no}`,
            message: `Dear ${i.insuredName ?? 'Customer'}, please complete the vehicle survey for claim ${row.claim_no}: ${link.url}`,
            claimNo: row.claim_no,
            reference: link.token,
        });
        results.push({ channel: channel === 'Whats App' ? 'WhatsApp' : channel, to, ...outcome });
    }
    const at = nowIso();
    const anyDelivered = results.some((r) => r.status === 'Delivered');
    const allFailed = results.every((r) => r.status === 'Failed');
    link.dispatch = { status: anyDelivered ? 'Sent' : allFailed ? 'Failed' : 'Pending', at, results };
    link.sentAt = at;
    link.reminderSentAt = null;

    transaction(() => {
        setClaimFields(row.id, { link: JSON.stringify(link) });
        for (const r of results) {
            insertCommunication(row.id, {
                direction: 'sent',
                type: 'Link Sent',
                tag: 'Survey Link',
                reference: `Survey link · ${r.channel}`,
                description: `Survey link sent to ${recipientLabel}.`,
                subDescription: r.error ?? link.url,
                person: 'Ibima Assist',
                personMeta: `(${actor.name})`,
                channel: r.channel,
                recipient: r.to,
                status: r.status,
                awaitingResponse: r.status !== 'Failed',
                createdBy: actor.id,
                at,
            });
        }
        audit(row.id, 'Survey link sent', `${results.map((r) => `${r.channel}: ${r.status}`).join(', ')}`, actor);
    });
    flush().catch(() => {});
    res.json({ link, claim: toClaim(findClaimRow(row.id)) });
}));

// ---------- remarks + audit trail (claim action bar) ----------

router.get('/claims/:id/remarks', (req, res) => {
    const row = loadClaim(req);
    res.json(listEvents(row.id, 'remark').map((e) => ({ id: e.id, text: e.detail, by: e.actorName, at: e.at })));
});

router.post('/claims/:id/remarks', (req, res) => {
    const row = loadClaim(req);
    const text = String(req.body?.text ?? '').trim();
    if (!text) throw badRequest('Write a remark first.');
    if (text.length > 1000) throw badRequest('Remark must be at most 1000 characters.');
    const actor = actorOf(req);
    addEvent(row.id, { kind: 'remark', action: 'Remark', detail: text, actor });
    audit(row.id, 'Remark added', text.slice(0, 120), actor);
    res.status(201).json(listEvents(row.id, 'remark').map((e) => ({ id: e.id, text: e.detail, by: e.actorName, at: e.at })));
});

/** GET /api/v1/claims/:id/audit -- Claim Audit Trail (newest first). */
router.get('/claims/:id/audit', (req, res) => {
    const row = loadClaim(req);
    res.json(listEvents(row.id, ['audit', 'stage']).map((e) => ({
        id: e.id, kind: e.kind, action: e.kind === 'stage' ? e.detail : e.action, detail: e.kind === 'stage' ? null : e.detail, by: e.actorName, at: e.at,
    })));
});

// ---------- Claim Details (vehicle / driver / loss / vahan tabs) + Claim Information (12 tabs) ----------

const FIELD_KEY = /^[A-Za-z][A-Za-z0-9]{0,40}$/;

/** Form values: strings (or string lists, e.g. Parts Damage tags), at most 200 fields. */
function cleanValues(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('values must be an object.');
    const out = {};
    for (const [k, v] of Object.entries(input).slice(0, 200)) {
        if (!FIELD_KEY.test(k) || v === undefined || v === null || v === '') continue;
        if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, 80)).slice(0, 40);
        else if (['string', 'number', 'boolean'].includes(typeof v)) out[k] = String(v).trim().slice(0, 2000);
    }
    for (const k of Object.keys(out)) {
        if (/(Contact|Mobile)(Number)?$/i.test(k) && typeof out[k] === 'string' && out[k]) {
            const p = normalizePhone(out[k]);
            const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
            if (!p) throw badRequest(`${label} must be a valid 10-digit mobile number.`);
            out[k] = p;
        }
        if (/(email|EmailAddress)$/i.test(k) && out[k] && !isEmail(out[k])) throw badRequest('Email address is not valid.');
    }
    return out;
}

const yearOf = (iso) => {
    const y = iso ? new Date(iso).getFullYear() : NaN;
    return Number.isNaN(y) ? null : y;
};
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const yesNo = (v) => (Array.isArray(v) ? v[0] : v);

/** First fill of Claim Details: what the intimation already captured. */
function detailsFromIntimation(i) {
    const year = yearOf(i.manufacturingYear);
    return compact({
        vehicleRegNo: i.registrationNumber, make: i.make, model: i.model, variant: i.variant, fuelType: i.fuelType,
        engineNumber: i.engineNo, chassisNumber: i.chassisNumber, colour: i.colour,
        yearOfManufacture: year ? String(year) : undefined,
        vehicleAge: year ? `${new Date().getFullYear() - year} Years` : undefined,
        driverName: i.driverName, driverLicenseNumber: i.drivingLicenseNumber,
        driverInjuryState: yesNo(i.driverInjured) === 'Yes' ? 'Minor' : undefined,
        causeOfAccident: i.natureOfLoss, lossDescription: i.briefDescription,
        rcOwnerName: i.insuredName, vahanEngineNumber: i.engineNo, vahanChassisNumber: i.chassisNumber,
        dlHolderName: i.driverName,
    });
}

router.get('/claims/:id/details', can(MODULES.details), (req, res) => {
    const row = loadClaim(req);
    const saved = getDoc(row.id, 'details');
    const values = saved?.values ?? detailsFromIntimation(parseJson(row.intimation, {}));
    res.json({ values, savedAt: saved?.updatedAt ?? null, savedBy: saved?.updatedBy ?? null });
});

/** PUT /api/v1/claims/:id/details { values, complete? } -- "Save Draft"; complete=true from "Next". */
router.put('/claims/:id/details', can(MODULES.details, 'edit'), (req, res) => {
    const row = loadClaim(req);
    if (row.status === 'Draft') throw badRequest('Submit the intimation first.');
    const values = cleanValues(req.body?.values ?? {});
    const actor = actorOf(req);
    const saved = transaction(() => {
        const doc = putDoc(row.id, 'details', { values }, actor);
        audit(row.id, 'Claim details saved', `${Object.keys(values).length} fields`, actor);
        if (req.body?.complete) completeStage(row.id, 'claim-details', actor);
        return doc;
    });
    if (req.body?.complete) syncClaim(row.id).catch(() => {});
    res.json({ values: saved.values, savedAt: saved.updatedAt, savedBy: saved.updatedBy, claim: toClaim(findClaimRow(row.id)) });
});

/** Claim Information first fill: everything the portal already knows about the claim. */
function infoFromClaim(row) {
    const i = parseJson(row.intimation, {});
    const d = getDoc(row.id, 'details')?.values ?? {};
    const sa = (t) => db.prepare("SELECT * FROM surveyor_assignments WHERE claim_id = ? AND survey_type = ? AND status = 'Assigned' ORDER BY assigned_at DESC LIMIT 1").get(row.id, t);
    const spot = sa('spot');
    const fin = sa('final');
    const sData = (a) => parseJson(a?.data, {});
    const liability = getDoc(row.id, 'fla') ?? getDoc(row.id, 'liability');
    const payment = getDoc(row.id, 'payment');
    const year = yearOf(i.manufacturingYear);
    const net = liability?.totals?.netLiability ? String(liability.totals.netLiability) : undefined;
    return compact({
        // Claim Information
        claimNumber: row.claim_no, insurerClaimReference: i.insurerClaimNumber, claimType: `${i.lineOfBusiness || 'Motor'} OD`,
        claimIntimationDate: row.submitted_at, policyNumber: row.policy_no, insurerTpa: i.insurerName,
        claimRegistrationDate: row.submitted_at, claimStatus: row.status, claimHandler: row.handler_name,
        accidentDate: i.dateOfIncident, accidentTime: i.timeOfIncident,
        accidentLocation: [i.incidentArea, i.incidentCity, i.incidentState].filter(Boolean).join(', ') || undefined,
        // Spot / Final survey
        spotSurveyorName: spot?.surveyor_name, spotSurveyorId: sData(spot).surveyorCode, spotAssignmentDate: spot?.assigned_at,
        finalSurveyorName: fin?.surveyor_name, finalSurveyorDate: fin?.assigned_at, assessedAmount: net,
        // Loss
        dateOfLoss: i.dateOfIncident, timeOfLoss: i.timeOfIncident,
        lossLocation: [i.incidentArea, i.incidentCity].filter(Boolean).join(', ') || undefined,
        causeOfLoss: d.causeOfAccident ?? i.natureOfLoss, lossInfoDescription: d.lossDescription ?? i.briefDescription,
        firDdrNumber: i.firNo, policeStation: i.policeStation, thirdPartyInvolvement: yesNo(i.thirdPartyInvolved),
        // Workshop
        workshopName: i.workshopName, workshopAddress: i.workshopAddress, workshopContactPerson: i.contactPersonName,
        // Driver
        driverName: d.driverName ?? i.driverName, driverContactNumber: d.driverContact,
        driverLicenseNumber: d.driverLicenseNumber ?? i.drivingLicenseNumber,
        // Vehicle
        registrationNumber: row.vehicle_no, registrationDate: i.registrationDate, make: d.make ?? i.make, model: d.model ?? i.model,
        variant: d.variant ?? i.variant, fuelType: d.fuelType ?? i.fuelType, manufacturingYear: year ? String(year) : undefined,
        chassisNumber: d.chassisNumber ?? i.chassisNumber, engineNumber: d.engineNumber ?? i.engineNo, colour: d.colour ?? i.colour,
        // Insured
        insuredName: row.insured_name, insuredMobileNumber: row.mobile, insuredEmailAddress: i.insuredEmail, registeredAddress: i.insuredAddress,
        insuredPolicyNumber: row.policy_no, policyStartDate: i.policyStartDate, policyExpiryDate: i.policyEndDate, rcOwnerName: d.rcOwnerName,
        // Claim provision
        initialClaimProvision: row.amount ? String(row.amount) : undefined, surveyorAssessedLiability: net, approvalStatus: payment?.status,
    });
}

/** GET /api/v1/claims/:id/info -- Claim Information tabs (saved values over the first fill). */
router.get('/claims/:id/info', can(MODULES.details), (req, res) => {
    const row = loadClaim(req);
    const saved = getDoc(row.id, 'info');
    res.json({ values: { ...infoFromClaim(row), ...(saved?.values ?? {}) }, savedAt: saved?.updatedAt ?? null, savedBy: saved?.updatedBy ?? null });
});

/** PUT /api/v1/claims/:id/info { values } -- Claim Information "Save Drift". */
router.put('/claims/:id/info', can(MODULES.details, 'edit'), (req, res) => {
    const row = loadClaim(req);
    if (row.status === 'Draft') throw badRequest('Submit the intimation first.');
    const values = cleanValues(req.body?.values ?? {});
    const actor = actorOf(req);
    const doc = putDoc(row.id, 'info', { values }, actor);
    audit(row.id, 'Claim information saved', `${Object.keys(values).length} fields`, actor);
    res.json({ values: doc.values, savedAt: doc.updatedAt, savedBy: doc.updatedBy });
});

export default router;
