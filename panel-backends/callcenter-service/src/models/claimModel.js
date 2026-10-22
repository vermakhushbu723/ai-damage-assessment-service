import { db, nowIso, parseJson } from '../db/database.js';
import { STAGES, STAGE_KEYS, COMPLETED, stageLabel } from '../constants.js';
import { yymmdd } from '../utils/ids.js';
import { settings } from '../config.js';

// Claims (table `claims`), their per-screen documents (`claim_docs`) and
// history (`events`).

const yes = (v) => (Array.isArray(v) ? v.includes('Yes') : v === 'Yes');

/** Dashboard priority from the intimation: injury / fatality / third party = High. */
export function priorityOf(intimation) {
    if (yes(intimation.anyFatality) || yes(intimation.anyInjury) || yes(intimation.driverInjured)) return 'High';
    if (yes(intimation.thirdPartyInvolved) || yes(intimation.policeReport)) return 'Medium';
    return intimation.isVehicleAtWorkshop && yes(intimation.isVehicleAtWorkshop) ? 'Low' : 'Medium';
}

/** Columns copied out of the intimation form (searched / listed). */
const columnsOf = (i) => ({
    source: i.intimationSource ?? null,
    insured_name: i.insuredName ?? null,
    mobile: i.insuredContact ?? null,
    vehicle_no: i.registrationNumber ?? null,
    policy_no: i.policyNumber ?? null,
    city: i.incidentCity ?? null,
    state: i.incidentState ?? null,
    priority: priorityOf(i),
});

/** Next Assist Claim ID / Claim No pair: BIM-YYMMDD-NNNN + CLM-YYMMDD-NNNN (one running number). */
export function nextClaimIds() {
    const row = db.prepare("SELECT MAX(CAST(substr(id, 12) AS INTEGER)) AS n FROM claims WHERE id GLOB 'BIM-[0-9]*'").get();
    const n = Math.max(1000, row.n ?? 0) + 1;
    const day = yymmdd();
    return { id: `BIM-${day}-${n}`, claimNo: `CLM-${day}-${n}` };
}

export function insertClaim(intimation, actor) {
    const { id, claimNo } = nextClaimIds();
    const now = nowIso();
    const c = columnsOf(intimation);
    db.prepare(`INSERT INTO claims (id, claim_no, status, stage, priority, source, insured_name, mobile, vehicle_no, policy_no, city, state,
                    intimation, created_by, created_by_name, created_at, updated_at)
                VALUES (?, ?, 'Draft', 'intimation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, claimNo, c.priority, c.source, c.insured_name, c.mobile, c.vehicle_no, c.policy_no, c.city, c.state,
            JSON.stringify(intimation), actor.id, actor.name, now, now);
    return id;
}

export function updateIntimation(id, intimation) {
    const c = columnsOf(intimation);
    db.prepare(`UPDATE claims SET priority = ?, source = ?, insured_name = ?, mobile = ?, vehicle_no = ?, policy_no = ?, city = ?, state = ?,
                    intimation = ?, updated_at = ? WHERE id = ?`)
        .run(c.priority, c.source, c.insured_name, c.mobile, c.vehicle_no, c.policy_no, c.city, c.state, JSON.stringify(intimation), nowIso(), id);
}

/** By Assist Claim ID or Claim No. */
export const findClaimRow = (ref) => db.prepare('SELECT * FROM claims WHERE id = ? OR claim_no = ?').get(ref, ref);

export function setClaimFields(id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return;
    db.prepare(`UPDATE claims SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...cols.map((c) => fields[c]), nowIso(), id);
}

// ---------- events ----------

export function addEvent(claimId, { kind, action, detail = null, data = {}, actor }) {
    db.prepare('INSERT INTO events (claim_id, kind, action, detail, data, actor_id, actor_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(claimId, kind, action, detail, JSON.stringify(data), actor?.id ?? null, actor?.name ?? 'System', nowIso());
}

/** Claim Audit Trail entry. */
export const audit = (claimId, action, detail, actor, data) => addEvent(claimId, { kind: 'audit', action, detail, data, actor });

export function listEvents(claimId, kinds) {
    const list = Array.isArray(kinds) ? kinds : [kinds];
    return db.prepare(`SELECT * FROM events WHERE claim_id = ? AND kind IN (${list.map(() => '?').join(', ')}) ORDER BY at DESC, id DESC`)
        .all(claimId, ...list)
        .map((e) => ({ id: e.id, kind: e.kind, action: e.action, detail: e.detail, data: parseJson(e.data, {}), actorId: e.actor_id, actorName: e.actor_name, at: e.at }));
}

/** { stageKey: completedAt } */
export function completedStages(claimId) {
    const rows = db.prepare("SELECT action, MIN(at) AS at FROM events WHERE claim_id = ? AND kind = 'stage' GROUP BY action").all(claimId);
    return Object.fromEntries(rows.map((r) => [r.action, r.at]));
}

/**
 * Marks a journey step done (once) and moves the claim's `stage` to the first
 * step not done yet. Returns true when this call completed it.
 */
export function completeStage(claimId, key, actor) {
    const done = completedStages(claimId);
    const first = !done[key];
    if (first) {
        addEvent(claimId, { kind: 'stage', action: key, detail: `${stageLabel(key)} completed`, actor });
        done[key] = nowIso();
    }
    const next = STAGE_KEYS.find((k) => !done[k]) ?? COMPLETED;
    setClaimFields(claimId, { stage: next, ...(next === COMPLETED ? { status: 'Closed' } : {}) });
    return first;
}

// ---------- per-screen documents ----------

export function getDoc(claimId, key, fallback = null) {
    const row = db.prepare('SELECT data, updated_at, updated_by FROM claim_docs WHERE claim_id = ? AND key = ?').get(claimId, key);
    return row ? { ...parseJson(row.data, {}), updatedAt: row.updated_at, updatedBy: row.updated_by } : fallback;
}

export function putDoc(claimId, key, data, actor) {
    const { updatedAt: _a, updatedBy: _b, ...clean } = data;
    db.prepare(`INSERT INTO claim_docs (claim_id, key, data, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT (claim_id, key) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(claimId, key, JSON.stringify(clean), actor?.name ?? null, nowIso());
    return getDoc(claimId, key);
}

// ---------- read model ----------

const minutesSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000)) : 0);

/** "2D 06H 24M" */
export function tatText(minutes) {
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    const m = minutes % 60;
    return `${d}D ${String(h).padStart(2, '0')}H ${String(m).padStart(2, '0')}M`;
}

/** List row (dashboard tables, search). */
export function toListItem(row) {
    const i = parseJson(row.intimation, {});
    return {
        id: row.id,
        claimNo: row.claim_no,
        status: row.status,
        stage: row.stage,
        stageLabel: stageLabel(row.stage),
        priority: row.priority,
        source: row.source,
        insuredName: row.insured_name,
        mobile: row.mobile,
        vehicleNo: row.vehicle_no,
        policyNo: row.policy_no,
        location: [row.city, row.state].filter(Boolean).join(', '),
        handlerId: row.handler_id,
        handlerName: row.handler_name,
        amount: row.amount,
        intimatedAt: row.submitted_at ?? i.intimationDateTime ?? row.created_at,
        submittedAt: row.submitted_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/** Everything the claim header (identity, meta, stage tracker) and the screens need. */
export function toClaim(row) {
    const i = parseJson(row.intimation, {});
    const done = completedStages(row.id);
    const openFor = row.status === 'Draft' ? 0 : minutesSince(row.submitted_at);
    return {
        ...toListItem(row),
        intimation: i,
        link: parseJson(row.link, {}),
        createdBy: row.created_by_name,
        productType: i.product ?? null,
        policyType: i.policyType ?? null,
        claimType: `${i.lineOfBusiness || 'Motor'} OD`,
        natureOfLoss: i.natureOfLoss ?? null,
        intimatedBy: i.callerName ? `${i.callerName}${i.relationshipWithInsured ? ` (${i.relationshipWithInsured})` : ''}` : null,
        workshop: i.workshopName ?? null,
        lossLocation: { city: i.incidentCity ?? null, state: i.incidentState ?? null, pincode: i.incidentPincode ?? null, area: i.incidentArea ?? null },
        insuredEmail: i.insuredEmail ?? null,
        tat: {
            text: tatText(openFor),
            minutes: openFor,
            slaRisk: row.status === 'Open' && openFor >= settings.slaHours * 60 * 0.75,
            breached: row.status === 'Open' && openFor >= settings.slaHours * 60,
        },
        stages: STAGES.map((s) => ({ ...s, done: !!done[s.key], at: done[s.key] ?? null })),
    };
}
