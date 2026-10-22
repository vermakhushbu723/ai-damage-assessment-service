import { db, nowIso } from '../db/database.js';

const toAuditDto = (r) => ({
    id: `LOG-${r.id}`,
    timestamp: r.timestamp,
    user: r.actor_name,
    userId: r.actor_id,
    role: r.actor_role ?? '—',
    action: r.action,
    module: r.module,
    status: r.status,
    detail: r.detail,
    ip: r.ip || '—',
    device: r.device || '—',
});

export function insertAuditLog({ actorId, actorName, actorRole, action, module, status, detail, ip, device }) {
    db.prepare(`INSERT INTO audit_logs (timestamp, actor_id, actor_name, actor_role, action, module, status, detail, ip, device)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(nowIso(), actorId ?? null, actorName, actorRole ?? null, action, module, status, detail ?? null, ip ?? null, device ?? null);
}

/** Newest first. Optional filters: from/to (ISO), user, role, module, action, status. */
export function listAuditLogs({ from, to, user, role, module, action, status, limit = 2000 } = {}) {
    const where = [];
    const values = [];
    const add = (sql, v) => { where.push(sql); values.push(v); };
    if (from) add('timestamp >= ?', from);
    if (to) add('timestamp <= ?', to);
    if (user) add('actor_name = ?', user);
    if (role) add('actor_role = ?', role);
    if (module) add('module = ?', module);
    if (action) add('action = ?', action);
    if (status) add('status = ?', status);
    const sql = `SELECT * FROM audit_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return db.prepare(sql).all(...values, Math.min(Number(limit) || 2000, 5000)).map(toAuditDto);
}
