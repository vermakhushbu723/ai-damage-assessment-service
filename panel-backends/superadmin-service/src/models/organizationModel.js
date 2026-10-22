import { db, nowIso } from '../db/database.js';

const parse = (text) => {
    try {
        return JSON.parse(text || '{}');
    } catch {
        return {};
    }
};

/** DB row -> API shape. `users` = live count of the organization's users. */
export const toOrgDto = (r) => r && ({
    id: r.id,
    name: r.name,
    type: r.type,
    status: r.status,
    idType: r.id_type,
    serviceModel: r.service_model,
    plan: r.plan_id,
    subscriptionStart: r.subscription_start,
    subscriptionExpiry: r.subscription_expiry,
    adminLoginId: r.admin_login_id,
    users: r.users_count ?? 0,
    claims: r.live_claims ?? 0,
    workflow: parse(r.workflow),
    settings: parse(r.settings),
    form: parse(r.form),
    createdBy: r.created_by,
    createdOn: r.created_at,
    updatedOn: r.updated_at,
});

const SELECT = `SELECT o.*,
    (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id) AS users_count,
    (SELECT COUNT(*) FROM claims c WHERE c.organization_id = o.id) AS live_claims
    FROM organizations o`;

/** serviceModel = null -> every organization; otherwise only that service model's. */
export function listOrganizations(serviceModel = null) {
    const rows = serviceModel
        ? db.prepare(`${SELECT} WHERE o.service_model = ? ORDER BY o.created_at DESC`).all(serviceModel)
        : db.prepare(`${SELECT} ORDER BY o.created_at DESC`).all();
    return rows.map(toOrgDto);
}

export const findOrganization = (id) => toOrgDto(db.prepare(`${SELECT} WHERE o.id = ?`).get(id));

export const orgNameTaken = (name, exceptId = '') =>
    Boolean(db.prepare('SELECT 1 FROM organizations WHERE lower(name) = lower(?) AND id <> ?').get(name, exceptId));

export function insertOrganization(o) {
    const now = nowIso();
    db.prepare(`INSERT INTO organizations
        (id, name, type, status, id_type, service_model, plan_id, subscription_start, subscription_expiry, admin_login_id,
         workflow, settings, form, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        o.id, o.name, o.type, o.status, o.idType, o.serviceModel, o.plan ?? null, o.subscriptionStart ?? null, o.subscriptionExpiry ?? null,
        o.adminLoginId ?? null, JSON.stringify(o.workflow ?? {}), JSON.stringify(o.settings ?? {}), JSON.stringify(o.form ?? {}),
        o.createdBy ?? null, now, now,
    );
    return findOrganization(o.id);
}

const COLUMNS = {
    name: 'name', type: 'type', status: 'status', idType: 'id_type', serviceModel: 'service_model', plan: 'plan_id',
    subscriptionStart: 'subscription_start', subscriptionExpiry: 'subscription_expiry',
    workflow: 'workflow', settings: 'settings', form: 'form',
};
const JSON_COLUMNS = new Set(['workflow', 'settings', 'form']);

export function updateOrganization(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
        if (patch[key] === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(JSON_COLUMNS.has(key) ? JSON.stringify(patch[key] ?? {}) : patch[key]);
    }
    if (sets.length) db.prepare(`UPDATE organizations SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
    return findOrganization(id);
}

export function setPlanForOrganizations(ids, planId) {
    const stmt = db.prepare('UPDATE organizations SET plan_id = ?, updated_at = ? WHERE id = ?');
    const now = nowIso();
    for (const id of ids) stmt.run(planId, now, id);
}
