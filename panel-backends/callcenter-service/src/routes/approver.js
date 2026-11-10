import { Router } from 'express';
import { db, nowIso, parseJson, transaction } from '../db/database.js';
import { asyncHandler, badRequest, conflict, HttpError, notFound } from '../utils/http.js';
import { authenticate, can, actorOf } from '../middleware/authenticate.js';
import { settings } from '../config.js';
import { MODULES, REGION_OF_STATE, MANAGER_DASHBOARD_ROLES } from '../constants.js';
import { findClaimRow, getDoc, putDoc, audit } from '../models/claimModel.js';
import { openTriggers } from '../services/adminClient.js';
import { syncClaim } from '../services/sync.js';
import { inr } from '../utils/format.js';
import { addQuickFilters, loadClaim } from './claims.js';

// SCM / RCM & Approver dashboard: fraud-triggered claims, SLA risk by region,
// ILA/FLA reports waiting for authorization and the payment queue -- plus the
// approver's decisions on them.

const router = Router();
router.use(authenticate);

const HOUR = 3600_000;
const WEEK = 7 * 24 * HOUR;
const REGIONS = ['North', 'South', 'West', 'East', 'Central'];
const KIND_LABEL = { liability: 'ILA', fla: 'FLA' };

/** Only State / Regional Claim Managers open this dashboard. */
function managersOnly(req, _res, next) {
    if (MANAGER_DASHBOARD_ROLES.includes(req.user?.roleKey)) return next();
    return next(new HttpError(403, `Your role (${req.user?.roleName ?? 'unknown'}) has no approver dashboard.`));
}

/** States the manager looks after: SCM -> their state, RCM -> every state of their region, no state set -> all. */
function scopeOf(user) {
    const all = { label: 'All India', states: null };
    if (!user?.state) return all;
    if (user.roleKey === 'state-manager') return { label: user.state, states: [user.state] };
    const region = REGION_OF_STATE[user.state];
    if (!region) return all;
    return { label: `${region} Region`, states: Object.keys(REGION_OF_STATE).filter((s) => REGION_OF_STATE[s] === region) };
}

function scopedClaims(user, query = {}) {
    const scope = scopeOf(user);
    const where = ["status <> 'Draft'"];
    const params = [];
    if (scope.states) {
        where.push(`state IN (${scope.states.map(() => '?').join(',')})`);
        params.push(...scope.states);
    }
    addQuickFilters(query, where, params);
    return { scope, rows: db.prepare(`SELECT * FROM claims WHERE ${where.join(' AND ')}`).all(...params) };
}

function pageOf(rows, page, pageSize) {
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    const p = Math.min(Math.max(1, Number(page) || 1), totalPages);
    return { rows: rows.slice((p - 1) * pageSize, p * pageSize), page: p, totalPages, total: rows.length };
}

/** "+18" / "-9" against the 7 days before. */
function trendOf(times, now) {
    const t = times.filter(Boolean).map((x) => Date.parse(x));
    const cur = t.filter((x) => x >= now - WEEK).length;
    const prev = t.filter((x) => x >= now - 2 * WEEK && x < now - WEEK).length;
    const d = cur - prev;
    return { value: `${d > 0 ? '+' : ''}${d}`, direction: d < 0 ? 'down' : 'up', label: 'VS Last 7 Days' };
}

function pctTrend(cur, prev) {
    if (!prev) return { value: cur ? 'New' : '0%', direction: 'up', label: 'VS Last 7 Days' };
    const pct = ((cur - prev) / prev) * 100;
    return { value: `${pct.toFixed(1)}%`, direction: pct < 0 ? 'down' : 'up', label: 'VS Last 7 Days' };
}

const severityOf = (score) => (score >= 50 ? 'Critical' : score >= 30 ? 'High' : score >= 15 ? 'Medium' : 'Low');

const aiScoreOf = (claimId) =>
    db.prepare('SELECT AVG(confidence) AS a FROM damage_items WHERE claim_id = ? AND deleted_at IS NULL AND confidence IS NOT NULL').get(claimId).a;

const intimationOf = (row) => parseJson(row.intimation, {});

/** Payment ETA: the 4 PM IST batch of the approval day, or the next day after 4 PM. */
function paymentEta(approvedAt) {
    if (!approvedAt) return null;
    const ist = new Date(Date.parse(approvedAt) + 5.5 * HOUR);
    const batch = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 16) - 5.5 * HOUR);
    return (Date.parse(approvedAt) < batch.getTime() ? batch : new Date(batch.getTime() + 24 * HOUR)).toISOString();
}

const PAYMENT_STATUS = { 'Pending Approval': 'Processing', Approved: 'Ready', 'Transfer Initiated': 'Awaiting Transfer' };

/**
 * GET /api/v1/approver/dashboard?fraudPage=&ilaPage=&paymentPage=&pageSize=&fraudPageSize=&ilaPageSize=&paymentPageSize=
 *     &from=&to=&source=&priority=&location=&insurer=
 * Everything the SCM / RCM & Approver dashboard shows, limited to the manager's states.
 */
router.get('/approver/dashboard', managersOnly, can(MODULES.dashboard), asyncHandler(async (req, res) => {
    const now = Date.now();
    // Each table has its own page size, so one table's View All leaves the others alone.
    const sizeOf = (name) => Math.min(50, Math.max(1, Number(req.query[`${name}PageSize`]) || Number(req.query.pageSize) || 7));
    const { scope, rows } = scopedClaims(req.user, req.query);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const byNo = new Map(rows.map((r) => [r.claim_no, r]));
    const open = rows.filter((r) => r.status === 'Open');

    // ---- fraud (triggers live in the Admin portal) ----
    let fraudAvailable = true;
    let triggers = [];
    try {
        triggers = (await openTriggers()).filter((t) => byNo.has(t.claim));
    } catch {
        fraudAvailable = false;
    }
    const fraudRows = triggers
        .map((t) => {
            const row = byNo.get(t.claim);
            const score = aiScoreOf(row.id);
            return {
                triggerId: t.id,
                claimId: row.id,
                claimNo: row.claim_no,
                stage: row.stage,
                customer: row.insured_name,
                insurer: intimationOf(row).insurerName ?? null,
                aiScore: score === null || score === undefined ? null : Math.round(score),
                reason: t.trigger,
                priority: severityOf(Number(t.score) || 0),
                at: t.at,
            };
        })
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));

    // ---- high value (open claims at or above the threshold) ----
    const high = open.filter((r) => (r.amount ?? 0) >= settings.highValueAmount);
    const sumSince = (from, to) =>
        high.filter((r) => { const t = Date.parse(r.submitted_at); return t >= from && t < to; }).reduce((s, r) => s + r.amount, 0);

    // ---- SLA ----
    const ageHours = (r) => (now - Date.parse(r.submitted_at)) / HOUR;
    const atRisk = open.filter((r) => { const left = settings.slaHours - ageHours(r); return left >= 0 && left <= settings.slaRiskHours; });
    const regionOf = (r) => REGION_OF_STATE[r.state] ?? 'Other';
    const regions = [...REGIONS, 'Other']
        .map((name) => {
            const list = open.filter((r) => regionOf(r) === name);
            if (!list.length && name === 'Other') return null;
            const avg = list.length ? list.reduce((s, r) => s + ageHours(r), 0) / list.length : 0;
            return {
                region: name,
                pending: list.length,
                avgTatHours: Math.round(avg),
                slaRemainingHours: list.length ? Math.max(0, Math.round(settings.slaHours - avg)) : null,
                slaHours: settings.slaHours,
            };
        })
        .filter(Boolean);
    const insurerTotals = new Map();
    for (const r of open) {
        const name = intimationOf(r).insurerName || 'Others';
        insurerTotals.set(name, (insurerTotals.get(name) ?? 0) + (r.amount ?? 0));
    }
    const sorted = [...insurerTotals.entries()].sort((a, b) => b[1] - a[1]);
    const grand = sorted.reduce((s, [, v]) => s + v, 0);
    const top = sorted.slice(0, 4);
    const rest = sorted.slice(4).reduce((s, [, v]) => s + v, 0);
    const insurers = [...top, ...(rest ? [['Others', rest]] : [])].map(([name, amount]) => ({
        name,
        amount,
        pct: grand ? Math.round((amount / grand) * 100) : 0,
    }));

    // ---- ILA / FLA reports waiting for authorization ----
    const docs = db.prepare("SELECT claim_id, key, data FROM claim_docs WHERE key IN ('liability', 'fla', 'payment')").all();
    const authRows = [];
    const payRows = [];
    for (const d of docs) {
        const row = byId.get(d.claim_id);
        if (!row) continue;
        const data = parseJson(d.data, {});
        if (d.key !== 'payment') {
            if (data.status === 'Submitted' && !data.authorization) {
                authRows.push({ claimId: row.id, claimNo: row.claim_no, kind: d.key, type: KIND_LABEL[d.key], assignedTo: row.handler_name, since: data.submittedAt, status: 'Pending' });
            }
            continue;
        }
        if (!PAYMENT_STATUS[data.status]) continue;
        const payees = data.payees ?? [];
        payRows.push({
            claimId: row.id,
            claimNo: row.claim_no,
            beneficiary: payees.length ? `${payees[0].payeeName}${payees.length > 1 ? ` +${payees.length - 1}` : ''}` : row.insured_name,
            amount: payees.reduce((s, p) => s + (Number(p.amount) || 0), 0),
            approvedAt: data.approvedAt ?? null,
            eta: paymentEta(data.approvedAt),
            status: PAYMENT_STATUS[data.status],
            rawStatus: data.status,
            submittedAt: data.submittedAt ?? null,
        });
    }
    authRows.sort((a, b) => String(a.since).localeCompare(String(b.since)));
    payRows.sort((a, b) => String(b.approvedAt ?? b.submittedAt).localeCompare(String(a.approvedAt ?? a.submittedAt)));
    const ready = payRows.filter((p) => p.rawStatus === 'Approved');

    res.json({
        scope: scope.label,
        settings: { highValueAmount: settings.highValueAmount, slaHours: settings.slaHours, slaRiskHours: settings.slaRiskHours },
        kpis: {
            fraudTriggered: { value: new Set(fraudRows.map((f) => f.claimId)).size, available: fraudAvailable, trend: trendOf(fraudRows.map((f) => f.at), now) },
            highValue: { value: high.reduce((s, r) => s + r.amount, 0), count: high.length, trend: pctTrend(sumSince(now - WEEK, now + HOUR), sumSince(now - 2 * WEEK, now - WEEK)) },
            slaRisk: { value: atRisk.length, trend: trendOf(atRisk.map((r) => r.submitted_at), now) },
            ilaFlaQueue: { value: authRows.length, trend: trendOf(authRows.map((a) => a.since), now) },
            paymentQueue: { value: ready.length, trend: trendOf(ready.map((p) => p.approvedAt), now) },
        },
        fraud: { available: fraudAvailable, ...pageOf(fraudRows, req.query.fraudPage, sizeOf('fraud')) },
        sla: { regions, insurers },
        authorization: pageOf(authRows, req.query.ilaPage, sizeOf('ila')),
        payments: pageOf(payRows, req.query.paymentPage, sizeOf('payment')),
    });
}));

const DECISIONS = {
    liability: ['approve', 'reject'],
    fla: ['approve', 'reject'],
    payment: ['approve', 'reject', 'transfer', 'paid'],
};

/**
 * POST /api/v1/approver/claims/:id/decision { kind: liability|fla|payment, decision, remark }
 *  liability / fla: approve, or reject (sends the report back to the handler as a draft).
 *  payment: approve | reject (back to the handler) | transfer (initiated) | paid (leaves the queue).
 */
router.post('/approver/claims/:id/decision', managersOnly, can(MODULES.approval, 'approve'), asyncHandler(async (req, res) => {
    const { kind, decision } = req.body ?? {};
    const remark = String(req.body?.remark ?? '').trim().slice(0, 500);
    if (!DECISIONS[kind]) throw badRequest('kind must be liability, fla or payment.');
    if (!DECISIONS[kind].includes(decision)) throw badRequest(`decision must be one of: ${DECISIONS[kind].join(', ')}.`);
    if (decision === 'reject' && !remark) throw badRequest('Give a reason for rejecting.');

    const row = loadClaim(req);
    const { states } = scopeOf(req.user);
    if (states && !states.includes(row.state)) throw notFound('Claim');
    const doc = getDoc(row.id, kind);
    if (!doc) throw notFound(kind === 'payment' ? 'Payment recommendation' : `${KIND_LABEL[kind]} report`);
    const actor = actorOf(req);
    const at = nowIso();
    const by = { id: actor.id, name: actor.name, role: req.user.roleName };

    let next;
    let action;
    if (kind !== 'payment') {
        if (doc.status !== 'Submitted' || doc.authorization) throw conflict(`This ${KIND_LABEL[kind]} report is not waiting for authorization.`);
        if (decision === 'approve') {
            next = { ...doc, authorization: { status: 'Approved', at, by, remark } };
            action = `${KIND_LABEL[kind]} report authorized`;
        } else {
            next = { ...doc, status: 'Draft', rejection: { at, by, remark } };
            action = `${KIND_LABEL[kind]} report sent back`;
        }
    } else {
        const from = { approve: 'Pending Approval', reject: 'Pending Approval', transfer: 'Approved', paid: 'Transfer Initiated' }[decision];
        if (doc.status !== from) throw conflict(`The payment is "${doc.status ?? 'Draft'}"; ${decision} needs "${from}".`);
        if (decision === 'approve') {
            next = { ...doc, status: 'Approved', approvedAt: at, approvedBy: by, approvalRemark: remark };
            action = 'Payment approved';
        } else if (decision === 'reject') {
            next = { ...doc, status: 'Draft', rejection: { at, by, remark } };
            action = 'Payment sent back';
        } else if (decision === 'transfer') {
            next = { ...doc, status: 'Transfer Initiated', transferAt: at, transferBy: by };
            action = 'Payment transfer initiated';
        } else {
            next = { ...doc, status: 'Paid', paidAt: at, paidBy: by };
            action = 'Payment marked paid';
        }
    }
    transaction(() => {
        putDoc(row.id, kind, next, actor);
        const amount = kind === 'payment' ? (next.payees ?? []).reduce((s, p) => s + (Number(p.amount) || 0), 0) : next.totals?.netLiability;
        audit(row.id, action, [amount ? `₹${inr(amount)}` : null, remark || null].filter(Boolean).join(' · ') || null, actor);
    });
    await syncClaim(row.id);
    res.json({ claimId: row.id, kind, status: next.status, authorization: next.authorization ?? null, at, claim: findClaimRow(row.id)?.stage ?? null });
}));

export default router;
