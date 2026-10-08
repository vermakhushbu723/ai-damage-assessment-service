import { db, nowIso } from '../db/database.js';

const toDto = (r) => r && ({
    id: r.id,
    name: r.name,
    serviceType: r.service_type,
    applicableFor: r.applicable_for,
    description: r.description ?? '',
    sla: r.sla_hours,
    workingHours: r.working_hours,
    escalationAfter: r.escalation_after,
    escalationTo: r.escalation_to,
    priority: r.priority,
    status: r.status,
    lastUploaded: r.updated_at,
    createdOn: r.created_at,
});

export const listServiceModels = () => db.prepare('SELECT * FROM service_models ORDER BY updated_at DESC').all().map(toDto);
export const findServiceModel = (id) => toDto(db.prepare('SELECT * FROM service_models WHERE id = ?').get(id));
export const serviceModelNameTaken = (name, exceptId = '') =>
    Boolean(db.prepare('SELECT 1 FROM service_models WHERE lower(name) = lower(?) AND id <> ?').get(name, exceptId));

export function insertServiceModel(m) {
    const now = nowIso();
    db.prepare(`INSERT INTO service_models (id, name, service_type, applicable_for, description, sla_hours, working_hours, escalation_after, escalation_to, priority, status, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        m.id, m.name, m.serviceType, m.applicableFor, m.description ?? null, m.sla, m.workingHours, m.escalationAfter, m.escalationTo,
        m.priority, m.status, m.createdBy ?? null, now, now,
    );
    return findServiceModel(m.id);
}

const COLUMNS = {
    name: 'name', serviceType: 'service_type', applicableFor: 'applicable_for', description: 'description', sla: 'sla_hours',
    workingHours: 'working_hours', escalationAfter: 'escalation_after', escalationTo: 'escalation_to', priority: 'priority', status: 'status',
};

export function updateServiceModel(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
        if (patch[key] === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(patch[key]);
    }
    if (sets.length) db.prepare(`UPDATE service_models SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
    return findServiceModel(id);
}
