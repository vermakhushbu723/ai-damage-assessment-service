import { db, nowIso } from '../db/database.js';
import { normalizePhone } from '../utils/http.js';

// Admin portal sign-in accounts (table `admins`).

export const toAdminDto = (r) => (r ? {
    id: r.id, name: r.name, email: r.email, mobile: r.mobile, status: r.status, role: 'Admin', lastLoginAt: r.last_login_at, createdAt: r.created_at,
} : null);

export const findAdminRowById = (id) => db.prepare('SELECT * FROM admins WHERE id = ?').get(id);
export const findAdminById = (id) => toAdminDto(findAdminRowById(id));

/** Email (any case) or 10-digit mobile number. */
export function findAdminRowByIdentifier(identifier) {
    const id = String(identifier ?? '').trim();
    if (id.includes('@')) return db.prepare('SELECT * FROM admins WHERE lower(email) = lower(?)').get(id);
    const phone = normalizePhone(id);
    return phone ? db.prepare('SELECT * FROM admins WHERE mobile = ?').get(phone) : undefined;
}

export const countAdmins = () => db.prepare('SELECT COUNT(*) AS n FROM admins').get().n;

export function insertAdmin({ id, name, email, mobile, passwordHash }) {
    const now = nowIso();
    db.prepare('INSERT INTO admins (id, name, email, mobile, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, email, mobile || null, passwordHash, now, now);
    return findAdminById(id);
}

export function setAdminPassword(id, passwordHash) {
    db.prepare('UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ?').run(passwordHash, nowIso(), id);
}

export function recordLoginSuccess(id) {
    db.prepare('UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(nowIso(), id);
}

/** Counts a wrong password; locks the account after `max` in a row. */
export function recordLoginFailure(id, max, lockMinutes) {
    const failed = db.prepare('SELECT failed_logins FROM admins WHERE id = ?').get(id).failed_logins + 1;
    const lockedUntil = failed >= max ? new Date(Date.now() + lockMinutes * 60_000).toISOString() : null;
    db.prepare('UPDATE admins SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lockedUntil ? 0 : failed, lockedUntil, id);
    return { failed, lockedUntil };
}
