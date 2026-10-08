import { db, nowIso, parseJson } from '../db/database.js';

// Roles & Permissions (table `roles`).

const toRole = (r) => ({
    key: r.key,
    name: r.name,
    short: r.short,
    ...(r.form_name ? { formName: r.form_name } : {}),
    ...(r.chart_label ? { chartLabel: r.chart_label } : {}),
    level: r.level,
    extra: r.extra,
    permissions: parseJson(r.permissions, {}),
    isSystem: !!r.is_system,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
});

export const listRoles = () => db.prepare('SELECT * FROM roles ORDER BY sort_order, created_at').all().map(toRole);
export function findRole(key) {
    const row = db.prepare('SELECT * FROM roles WHERE key = ?').get(key);
    return row ? toRole(row) : null;
}
export function findRoleByName(name) {
    const row = db.prepare('SELECT * FROM roles WHERE lower(name) = lower(?)').get(name);
    return row ? toRole(row) : null;
}

export function insertRole({ key, name, short, formName, chartLabel, level, extra, permissions, isSystem = false }) {
    const now = nowIso();
    const sort = (db.prepare('SELECT MAX(sort_order) AS s FROM roles').get().s ?? 0) + 1;
    db.prepare(`INSERT INTO roles (key, name, short, form_name, chart_label, level, extra, permissions, is_system, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(key, name, short ?? null, formName ?? null, chartLabel ?? null, level, extra ?? null, JSON.stringify(permissions), isSystem ? 1 : 0, sort, now, now);
    return findRole(key);
}

export function updateRole(key, { name, short, level, permissions }) {
    const current = findRole(key);
    if (!current) return null;
    db.prepare('UPDATE roles SET name = ?, short = ?, level = ?, permissions = ?, updated_at = ? WHERE key = ?').run(
        name ?? current.name, short ?? current.short, level ?? current.level, JSON.stringify(permissions ?? current.permissions), nowIso(), key,
    );
    return findRole(key);
}

export const deleteRole = (key) => db.prepare('DELETE FROM roles WHERE key = ?').run(key).changes > 0;
export const countRoles = () => db.prepare('SELECT COUNT(*) AS n FROM roles').get().n;
