import { db, nowIso } from '../db/database.js';
import { normalizePhone } from '../utils/http.js';

/** DB row -> API shape (never includes the password hash). */
export const toAdminDto = (r) => r && ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    role: r.role,
    scope: r.scope,
    status: r.status,
    mfa: Boolean(r.mfa),
    lastLogin: r.last_login_at,
    createdOn: r.created_at,
    updatedOn: r.updated_at,
});

export const findAdminRowById = (id) => db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id);
export const findAdminById = (id) => toAdminDto(findAdminRowById(id));

/** Login lookup by email (case-insensitive) or 10-digit mobile number. */
export function findAdminRowByIdentifier(identifier) {
    const value = String(identifier ?? '').trim();
    if (value.includes('@')) return db.prepare('SELECT * FROM admin_users WHERE lower(email) = lower(?)').get(value);
    const phone = normalizePhone(value);
    if (!phone) return undefined;
    return db.prepare('SELECT * FROM admin_users').all().find((r) => normalizePhone(r.phone) === phone);
}

export const emailTaken = (email, exceptId = '') =>
    Boolean(db.prepare('SELECT 1 FROM admin_users WHERE lower(email) = lower(?) AND id <> ?').get(email, exceptId));

export const listAdmins = () => db.prepare('SELECT * FROM admin_users ORDER BY created_at DESC').all().map(toAdminDto);

export function insertAdmin({ id, name, email, phone, role, scope, status, mfa, passwordHash }) {
    const now = nowIso();
    db.prepare(`INSERT INTO admin_users (id, name, email, phone, role, scope, status, mfa, password_hash, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, name, email, phone ?? null, role, scope, status, mfa ? 1 : 0, passwordHash, now, now);
    return findAdminById(id);
}

const ADMIN_COLUMNS = { name: 'name', email: 'email', phone: 'phone', role: 'role', scope: 'scope', status: 'status', mfa: 'mfa', passwordHash: 'password_hash' };

export function updateAdmin(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(ADMIN_COLUMNS)) {
        if (patch[key] === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(key === 'mfa' ? (patch[key] ? 1 : 0) : patch[key]);
    }
    if (sets.length) {
        db.prepare(`UPDATE admin_users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
    }
    return findAdminById(id);
}

export function recordLoginSuccess(id) {
    db.prepare('UPDATE admin_users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(nowIso(), id);
}

export function recordLoginFailure(id, maxFailed, lockMinutes) {
    const row = findAdminRowById(id);
    const failed = (row?.failed_logins ?? 0) + 1;
    const lockedUntil = failed >= maxFailed ? new Date(Date.now() + lockMinutes * 60_000).toISOString() : null;
    db.prepare('UPDATE admin_users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lockedUntil ? 0 : failed, lockedUntil, id);
    return { failed, lockedUntil };
}

export const countActiveMasters = () =>
    db.prepare("SELECT COUNT(*) AS n FROM admin_users WHERE role = 'Super Admin' AND scope = 'all' AND status = 'Active'").get().n;
