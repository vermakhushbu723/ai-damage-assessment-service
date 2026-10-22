import { db, nowIso, parseJson } from '../db/database.js';
import { ingest } from './adminClient.js';
import { findClaimRow, setClaimFields, addEvent, completeStage } from '../models/claimModel.js';
import { ADMIN_STAGE, ADMIN_CLAIM_TYPE, REGION_OF_STATE, ADMIN_CHANNEL, COMPLETED } from '../constants.js';
import { settings } from '../config.js';

// Every submitted claim (and its communication log) is pushed to the Admin
// portal through admin-service POST /claims/ingest -- the same door the claim
// systems use. Changes are queued in `outbox` first, so nothing is lost while
// admin-service is down; flush() retries every minute.
//
// The Admin portal runs its handler allocation rule on a new claim; the
// handler it picks comes back in the ingest response and is copied here.

const MAX_BATCH = 200;

export function queue(kind, ref) {
    db.prepare(`INSERT INTO outbox (kind, ref, created_at) VALUES (?, ?, ?)
                ON CONFLICT (kind, ref) DO UPDATE SET attempts = 0, last_error = NULL`).run(kind, ref, nowIso());
}

/** The claim as admin-service's ingest expects it. */
function claimPayload(row) {
    const i = parseJson(row.intimation, {});
    const openMin = row.submitted_at ? Math.round((Date.now() - new Date(row.submitted_at).getTime()) / 60000) : 0;
    return {
        id: row.claim_no,
        customer: row.insured_name ?? undefined,
        type: ADMIN_CLAIM_TYPE[i.product] ?? 'Motor Vehicle',
        ...(row.handler_id ? { handlerId: row.handler_id, handler: row.handler_name } : {}),
        amount: row.amount ?? undefined,
        slaDays: Math.ceil(settings.slaHours / 24),
        tatMinutes: row.stage === COMPLETED ? undefined : openMin,
        stage: ADMIN_STAGE[row.stage] ?? 'Intimation',
        ...(REGION_OF_STATE[row.state] ? { region: REGION_OF_STATE[row.state] } : {}),
        intimatedAt: row.submitted_at,
        vehicleNo: row.vehicle_no ?? undefined,
    };
}

function commPayload(c, claimNo) {
    return {
        id: c.id,
        claim: claimNo,
        communication: `${c.type} - ${c.tag}`.slice(0, 120),
        recipient: (c.person_meta ? `${c.person} ${c.person_meta}` : c.person).slice(0, 100),
        ...(c.recipient ? { to: c.recipient.slice(0, 120) } : {}),
        channel: ADMIN_CHANNEL[c.channel] ?? 'In App',
        status: c.status === 'Failed' ? 'Failed' : c.status === 'Pending' ? 'Pending' : 'Delivered',
        message: [c.description, c.sub_description].filter(Boolean).join('\n').slice(0, 4000),
        at: c.at,
    };
}

const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/** Copies the Admin portal's handler choice onto local claims that have none yet. */
function applyAssignments(assigned = []) {
    for (const a of assigned) {
        if (!a.handlerId) continue;
        const row = findClaimRow(a.claimId);
        if (!row || row.handler_id) continue;
        setClaimFields(row.id, { handler_id: a.handlerId, handler_name: a.handler ?? a.handlerId });
        const method = a.mode === 'requested' || a.mode === 'manual' ? 'Manual' : 'Auto (Admin allocation rule: branch & handler capacity)';
        addEvent(row.id, { kind: 'handler', action: 'Allocated', detail: `Allocated to ${a.handler ?? a.handlerId}`, data: { handlerId: a.handlerId, handlerName: a.handler, method }, actor: { name: 'System' } });
        addEvent(row.id, { kind: 'audit', action: 'Handler allocated', detail: `${a.handler ?? a.handlerId} (${method})`, actor: { name: 'System' } });
        completeStage(row.id, 'handler-allocation', { name: 'System' });
        // The stage moved: tell the Admin portal too.
        queue('claim', row.id);
    }
}

let flushing = null;

/** Pushes everything queued. Resolves to { sent, failed, error? }; never throws. */
export function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
        const items = db.prepare('SELECT * FROM outbox ORDER BY id LIMIT ?').all(MAX_BATCH * 5);
        if (!items.length) return { sent: 0, failed: 0 };
        const claims = [];
        const commLogs = [];
        const done = [];
        for (const item of items) {
            // Drafts stay queued: the Admin portal only learns about submitted claims.
            if (item.kind === 'claim') {
                const row = findClaimRow(item.ref);
                if (row?.status === 'Draft') continue;
                if (row) claims.push(strip(claimPayload(row)));
            } else if (item.kind === 'commLog') {
                const c = db.prepare('SELECT * FROM communications WHERE id = ?').get(item.ref);
                const claim = c && findClaimRow(c.claim_id);
                if (claim?.status === 'Draft') continue;
                if (claim) commLogs.push(strip(commPayload(c, claim.claim_no)));
            }
            done.push(item.id);
        }
        if (!done.length) return { sent: 0, failed: 0 };
        try {
            const result = claims.length || commLogs.length ? await ingest({ claims, commLogs }) : null;
            const del = db.prepare('DELETE FROM outbox WHERE id = ?');
            done.forEach((id) => del.run(id));
            // After the delete: an assignment re-queues its claim (stage moved).
            applyAssignments(result?.allocation?.assigned);
            return { sent: done.length, failed: 0, assigned: result?.allocation?.assigned ?? [] };
        } catch (err) {
            const upd = db.prepare('UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?');
            done.forEach((id) => upd.run(String(err.detail ?? err.message).slice(0, 300), id));
            return { sent: 0, failed: done.length, error: err.detail ?? err.message };
        }
    })().finally(() => {
        flushing = null;
    });
    return flushing;
}

/**
 * Queue + immediate push of one claim (after submit / stage changes). A
 * handler picked by the Admin portal re-queues the claim, so push twice at most.
 */
export async function syncClaim(claimId) {
    queue('claim', claimId);
    const first = await flush();
    if (!first.error && pendingCount()) await flush();
    return first;
}

export const pendingCount = () => db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;
