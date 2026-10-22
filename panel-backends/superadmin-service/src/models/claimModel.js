import { db, nowIso } from '../db/database.js';

const toDto = (r) => r && ({
    id: r.id,
    organizationId: r.organization_id,
    organization: r.org_name ?? null,
    serviceModel: r.org_service_model ?? null,
    customer: r.customer,
    claimType: r.claim_type,
    productType: r.product_type,
    handler: r.handler,
    amount: r.amount,
    slaDays: r.sla_days,
    status: r.status,
    intimationDate: r.intimation_date,
    settledAt: r.settled_at,
    branch: r.branch,
    region: r.region,
    state: r.state,
    source: r.source,
});

const SELECT = `SELECT c.*, o.name AS org_name, o.service_model AS org_service_model
                FROM claims c LEFT JOIN organizations o ON o.id = c.organization_id`;

/** serviceModel = null -> all claims; otherwise only claims of that service model's organizations. */
export function listClaims(serviceModel = null) {
    const rows = serviceModel
        ? db.prepare(`${SELECT} WHERE o.service_model = ? ORDER BY c.intimation_date DESC`).all(serviceModel)
        : db.prepare(`${SELECT} ORDER BY c.intimation_date DESC`).all();
    return rows.map(toDto);
}

export const findClaim = (id) => toDto(db.prepare(`${SELECT} WHERE c.id = ?`).get(id));

/** Insert or update by claim id (the source system's claim number). Returns 'created' | 'updated'. */
export function upsertClaim(c) {
    const now = nowIso();
    const exists = db.prepare('SELECT 1 FROM claims WHERE id = ?').get(c.id);
    const values = [
        c.organizationId ?? null, c.customer, c.claimType ?? null, c.productType ?? null, c.handler ?? null, c.amount ?? 0,
        c.slaDays ?? null, c.status, c.intimationDate, c.settledAt ?? null, c.branch ?? null, c.region ?? null, c.state ?? null, c.source ?? null,
    ];
    if (exists) {
        db.prepare(`UPDATE claims SET organization_id = ?, customer = ?, claim_type = ?, product_type = ?, handler = ?, amount = ?, sla_days = ?,
                    status = ?, intimation_date = ?, settled_at = ?, branch = ?, region = ?, state = ?, source = ?, updated_at = ? WHERE id = ?`)
            .run(...values, now, c.id);
        return 'updated';
    }
    db.prepare(`INSERT INTO claims (organization_id, customer, claim_type, product_type, handler, amount, sla_days, status, intimation_date,
                settled_at, branch, region, state, source, created_at, updated_at, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values, now, now, c.id);
    return 'created';
}
