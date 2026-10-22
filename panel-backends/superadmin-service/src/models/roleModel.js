import { db, nowIso } from '../db/database.js';
import { PERMISSION_PAGES, PERMISSION_ACTIONS } from '../constants.js';

const toRoleDto = (r) => r && ({
    name: r.name,
    permissions: JSON.parse(r.permissions),
    isSystem: Boolean(r.is_system),
    createdOn: r.created_at,
    updatedOn: r.updated_at,
});

/** Every page x action present and boolean; unknown pages/actions dropped. */
export function normalizeMatrix(input) {
    const src = input && typeof input === 'object' ? input : {};
    return Object.fromEntries(PERMISSION_PAGES.map((page) => [
        page,
        Object.fromEntries(PERMISSION_ACTIONS.map((a) => [a, Boolean(src[page]?.[a])])),
    ]));
}

export const listRoles = () => db.prepare('SELECT * FROM roles ORDER BY is_system DESC, created_at ASC').all().map(toRoleDto);
export const findRole = (name) => toRoleDto(db.prepare('SELECT * FROM roles WHERE lower(name) = lower(?)').get(name));

export function insertRole({ name, permissions, isSystem = false }) {
    const now = nowIso();
    db.prepare('INSERT INTO roles (name, permissions, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, JSON.stringify(normalizeMatrix(permissions)), isSystem ? 1 : 0, now, now);
    return findRole(name);
}

export function updateRolePermissions(name, permissions) {
    db.prepare('UPDATE roles SET permissions = ?, updated_at = ? WHERE name = ?').run(JSON.stringify(normalizeMatrix(permissions)), nowIso(), name);
    return findRole(name);
}

export const roleInUse = (name) => db.prepare('SELECT COUNT(*) AS n FROM admin_users WHERE role = ?').get(name).n;

export const deleteRole = (name) => db.prepare('DELETE FROM roles WHERE name = ?').run(name);
