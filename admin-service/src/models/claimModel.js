import { db, nowIso, parseJson } from '../db/database.js';

// Claims pushed by the claim systems (table `claims`). Handler and branch
// names are resolved from the portal's own users / branches when the ids match.

function lookups() {
    const users = Object.fromEntries(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    const branches = Object.fromEntries(db.prepare("SELECT id, data FROM records WHERE collection = 'branches'").all()
        .map((b) => [b.id, parseJson(b.data, {}).name]));
    return { users, branches };
}

function toClaim(row, { users, branches }) {
    const data = parseJson(row.data, {});
    return {
        ...data,
        id: row.id,
        handlerId: row.handler_id,
        handler: users[row.handler_id] ?? data.handler ?? null,
        stage: row.stage,
        region: row.region,
        branchId: row.branch_id,
        branch: branches[row.branch_id] ?? data.branch ?? null,
        amount: row.amount,
        intimatedAt: row.intimated_at,
        updatedAt: row.updated_at,
    };
}

export function listClaims() {
    const l = lookups();
    return db.prepare('SELECT * FROM claims ORDER BY intimated_at DESC').all().map((r) => toClaim(r, l));
}

export function findClaim(id) {
    const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
    return row ? toClaim(row, lookups()) : null;
}

const COLUMNS = ['id', 'handlerId', 'stage', 'region', 'branchId', 'amount', 'intimatedAt'];

/** Create or update by claim id. Returns 'created' | 'updated'. */
export function upsertClaim(claim) {
    const existing = db.prepare('SELECT * FROM claims WHERE id = ?').get(claim.id);
    const now = nowIso();
    const data = Object.fromEntries(Object.entries(claim).filter(([k]) => !COLUMNS.includes(k)));
    if (existing) {
        const merged = { ...parseJson(existing.data, {}), ...data };
        db.prepare('UPDATE claims SET handler_id = ?, stage = ?, region = ?, branch_id = ?, amount = ?, intimated_at = ?, data = ?, updated_at = ? WHERE id = ?').run(
            claim.handlerId !== undefined ? claim.handlerId : existing.handler_id,
            claim.stage ?? existing.stage,
            claim.region !== undefined ? claim.region : existing.region,
            claim.branchId !== undefined ? claim.branchId : existing.branch_id,
            claim.amount !== undefined ? claim.amount : existing.amount,
            claim.intimatedAt ?? existing.intimated_at,
            JSON.stringify(merged), now, claim.id,
        );
        return 'updated';
    }
    db.prepare('INSERT INTO claims (id, handler_id, stage, region, branch_id, amount, intimated_at, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        claim.id, claim.handlerId ?? null, claim.stage, claim.region ?? null, claim.branchId ?? null, claim.amount ?? null, claim.intimatedAt, JSON.stringify(data), now, now,
    );
    return 'created';
}

/** Moves up to `count` open claims (oldest first) from one handler to another. Returns the moved claim ids. */
export function reassignClaims(fromId, toId, count, openStages) {
    const placeholders = openStages.map(() => '?').join(', ');
    const ids = db.prepare(`SELECT id FROM claims WHERE handler_id = ? AND stage IN (${placeholders}) ORDER BY intimated_at ASC LIMIT ?`)
        .all(fromId, ...openStages, count).map((r) => r.id);
    const stmt = db.prepare('UPDATE claims SET handler_id = ?, updated_at = ? WHERE id = ?');
    const now = nowIso();
    ids.forEach((id) => stmt.run(toId, now, id));
    return ids;
}

export const countClaims = () => db.prepare('SELECT COUNT(*) AS n FROM claims').get().n;
