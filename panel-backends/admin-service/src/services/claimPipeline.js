import { db, parseJson, nowIso } from '../db/database.js';
import { OPEN_STAGES, DEFAULT_CAPACITY } from '../constants.js';
import { getSetting } from '../models/settingsModel.js';
import { listRecords, findRecord, insertRecord } from '../models/recordModel.js';
import { findClaim, upsertClaim } from '../models/claimModel.js';

// What happens to a claim pushed by a claim system (POST /claims/ingest):
//  1. Handler allocation rule (Allocation Load) -- a handler is "full" at
//     capacityLimit x thresholdPct% open claims; a new claim for a full / inactive
//     / missing handler goes to the least-loaded handler that still has room
//     (same branch first when overflow = branch-first).
//  2. Fraud trigger rules (published + active) are checked; each hit becomes a
//     trigger, routed by the Fraud Routing matrix (action, recipient, hold).

// ---------- allocation ----------

/** Active claim handlers with capacity, branch and current open claims. */
export function handlerPool() {
    const placeholders = OPEN_STAGES.map(() => '?').join(', ');
    const open = Object.fromEntries(db.prepare(`SELECT handler_id, COUNT(*) AS n FROM claims WHERE handler_id IS NOT NULL AND stage IN (${placeholders}) GROUP BY handler_id`)
        .all(...OPEN_STAGES).map((r) => [r.handler_id, r.n]));
    return db.prepare("SELECT id, name, data FROM users WHERE role_key = 'claim-handler' AND status = 'Active'").all().map((u) => {
        const data = parseJson(u.data, {});
        return { id: u.id, name: u.name, branchId: data.extra?.branchId ?? null, capacity: data.capacityLimit ?? DEFAULT_CAPACITY, open: open[u.id] ?? 0 };
    });
}

/** Most open claims a handler may hold under the rule (at least 1). */
export const limitOf = (h, rule) => Math.max(1, Math.floor((h.capacity * rule.thresholdPct) / 100));
const hasRoom = (h, rule) => h.open < limitOf(h, rule);

/** Least-loaded handler with room; same branch first when the rule says so. */
function pick(pool, rule, { branchId, exclude } = {}) {
    const candidates = pool.filter((h) => h.id !== exclude && hasRoom(h, rule));
    candidates.sort((a, b) => {
        if (rule.overflow === 'branch-first' && branchId) {
            const sa = a.branchId === branchId ? 0 : 1;
            const sb = b.branchId === branchId ? 0 : 1;
            if (sa !== sb) return sa - sb;
        }
        return a.open / limitOf(a, rule) - b.open / limitOf(b, rule) || a.open - b.open;
    });
    return candidates[0] ?? null;
}

/**
 * Decides the handler of a new, open claim. Mutates `pool` (open counts) so a
 * batch spreads out. Returns the claim fields to store.
 */
export function allocate(claim, pool, rule = getSetting('allocation')) {
    if (!OPEN_STAGES.includes(claim.stage)) return {};
    const requested = claim.handlerId ? pool.find((h) => h.id === claim.handlerId) : null;
    const take = (h, allocation) => {
        if (h) h.open += 1;
        return { handlerId: h?.id ?? claim.handlerId ?? null, allocation: { ...allocation, at: nowIso() } };
    };
    if (!rule.autoAllocate) return requested ? take(requested, { mode: 'manual' }) : {};
    if (requested && hasRoom(requested, rule)) return take(requested, { mode: 'requested' });
    const reason = !claim.handlerId ? 'No handler given' : !requested ? 'Requested handler not active' : `${requested.name} at maximum threshold (${limitOf(requested, rule)} open)`;
    const chosen = pick(pool, rule, { branchId: claim.branchId, exclude: requested?.id });
    if (chosen) return take(chosen, { mode: 'auto', reason, requestedHandlerId: claim.handlerId ?? null });
    // Everyone is full: keep the requested handler (if any) and flag it.
    return { ...(requested ? take(requested, {}) : {}), allocation: { mode: 'unallocated', reason: `${reason}; all handlers at maximum threshold`, requestedHandlerId: claim.handlerId ?? null, at: nowIso() } };
}

/**
 * "Rebalance now": moves open claims (newest first) off handlers above the
 * threshold to handlers with room. Returns [{ claimId, from, to }].
 */
export function rebalance(rule = getSetting('allocation')) {
    const pool = handlerPool();
    const moves = [];
    const placeholders = OPEN_STAGES.map(() => '?').join(', ');
    for (const h of [...pool].sort((a, b) => b.open / limitOf(b, rule) - a.open / limitOf(a, rule))) {
        let excess = h.open - limitOf(h, rule);
        if (excess <= 0) continue;
        const claims = db.prepare(`SELECT id, branch_id FROM claims WHERE handler_id = ? AND stage IN (${placeholders}) ORDER BY intimated_at DESC`).all(h.id, ...OPEN_STAGES);
        for (const c of claims) {
            if (excess <= 0) break;
            const to = pick(pool, rule, { branchId: c.branch_id, exclude: h.id });
            if (!to) break;
            upsertClaim({ id: c.id, handlerId: to.id, allocation: { mode: 'rebalanced', reason: `${h.name} above maximum threshold`, requestedHandlerId: h.id, at: nowIso() } });
            to.open += 1;
            h.open -= 1;
            excess -= 1;
            moves.push({ claimId: c.id, from: h.id, to: to.id });
        }
    }
    return moves;
}

// ---------- fraud ----------

/** Routing matrix row for a score ("50" = 50 and above, "30-49" = range). */
export function routeForScore(score, matrix = getSetting('routing').matrix) {
    return matrix.filter((r) => r.active).find((r) => {
        const [lo, hi] = String(r.score).split('-').map(Number);
        return Number.isFinite(hi) ? score >= lo && score <= hi : score >= lo;
    }) ?? null;
}

const routed = (score) => {
    const row = routeForScore(score);
    return row ? { route: row.action, reviewer: row.recipient, hold: row.hold, severity: row.severity } : {};
};

/** Fills route / reviewer of a pushed trigger from the routing matrix when the claim system left them empty. */
export function routeTrigger(t) {
    const r = routed(Number(t.score) || 0);
    return { ...t, route: t.route || r.route || '', reviewer: t.reviewer || r.reviewer || '', ...(r.hold ? { hold: r.hold } : {}) };
}

function priorClaimsOnVehicle(claim) {
    if (!claim.vehicleNo) return 0;
    const since = new Date(new Date(claim.intimatedAt).getTime() - 90 * 86400_000).toISOString();
    return db.prepare("SELECT COUNT(*) AS n FROM claims WHERE json_extract(data, '$.vehicleNo') = ? AND intimated_at >= ? AND intimated_at <= ?")
        .get(claim.vehicleNo, since, claim.intimatedAt).n;
}

/** Does a fraud rule fire for this claim? Unknown rule keys fall back to the amount threshold. */
function fires(rule, claim) {
    switch (rule.key) {
        case 'priorClaims': return priorClaimsOnVehicle(claim) >= (rule.threshold ?? 3);
        case 'amount': return (claim.amount ?? 0) > (rule.threshold ?? 50000);
        case 'duplicate': return claim.duplicateDocument === true;
        case 'mismatch': return claim.damageMismatch === true;
        default: return rule.threshold != null && (claim.amount ?? 0) > rule.threshold;
    }
}

/** Runs the published, active fraud rules on a stored claim. Returns the new triggers. */
export function evaluateFraud(claimId) {
    const claim = findClaim(claimId);
    if (!claim) return [];
    const created = [];
    let hold = false;
    for (const rule of listRecords('fraudRules', { order: 'asc' })) {
        if (!rule.active || rule.pending || !fires(rule, claim)) continue;
        const id = `TRG-${claim.id}-${rule.id}`.slice(0, 60);
        if (findRecord('triggers', id)) continue;
        const r = routed(Number(rule.score) || 0);
        const trigger = { id, at: nowIso(), claim: claim.id, trigger: rule.rule, ruleId: rule.id, score: Number(rule.score) || 0, route: r.route ?? '', reviewer: r.reviewer ?? '', hold: r.hold ?? 'No', status: 'Open', auto: true };
        insertRecord('triggers', trigger);
        created.push(trigger);
        if (r.hold === 'Yes') hold = true;
    }
    if (hold && !claim.onHold) upsertClaim({ id: claim.id, onHold: true });
    return created;
}

/** A pushed trigger that says "hold" puts its claim on hold too. */
export function applyTriggerHold(t) {
    if (t.hold === 'Yes' && t.status !== 'Cleared' && findClaim(t.claim)) upsertClaim({ id: t.claim, onHold: true });
}
