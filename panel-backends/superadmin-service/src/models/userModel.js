import { db, nowIso } from '../db/database.js';

/** DB row (joined with its organization) -> API shape. */
export const toUserDto = (r) => r && ({
    id: r.id,
    userId: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    organizationId: r.organization_id,
    organization: r.org_name,
    serviceModel: r.org_service_model,
    role: r.role,
    branch: r.branch,
    platform: r.platform,
    status: r.status,
    mustChangePassword: Boolean(r.must_change_password),
    lastLogin: r.last_login_at,
    createdOn: r.created_at,
    updatedOn: r.updated_at,
});

const SELECT = `SELECT u.*, o.name AS org_name, o.service_model AS org_service_model
                FROM users u JOIN organizations o ON o.id = u.organization_id`;

export function listUsers(serviceModel = null) {
    const rows = serviceModel
        ? db.prepare(`${SELECT} WHERE o.service_model = ? ORDER BY u.created_at DESC`).all(serviceModel)
        : db.prepare(`${SELECT} ORDER BY u.created_at DESC`).all();
    return rows.map(toUserDto);
}

export const findUserRow = (id) => db.prepare(`${SELECT} WHERE lower(u.id) = lower(?)`).get(id);
export const findUser = (id) => toUserDto(findUserRow(id));

export function insertUser(u) {
    const now = nowIso();
    db.prepare(`INSERT INTO users (id, organization_id, name, email, phone, role, branch, platform, status, password_hash, must_change_password, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        u.id, u.organizationId, u.name, u.email, u.phone ?? null, u.role, u.branch ?? null, u.platform ?? null, u.status,
        u.passwordHash, u.mustChangePassword === false ? 0 : 1, now, now,
    );
    return findUser(u.id);
}

const COLUMNS = { name: 'name', email: 'email', phone: 'phone', role: 'role', branch: 'branch', platform: 'platform', status: 'status', organizationId: 'organization_id' };

export function updateUser(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
        if (patch[key] === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(patch[key]);
    }
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
    return findUser(id);
}

export function setUserPassword(id, passwordHash, mustChange) {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?').run(passwordHash, mustChange ? 1 : 0, nowIso(), id);
}

export const userIdTaken = (id) => Boolean(db.prepare('SELECT 1 FROM users WHERE lower(id) = lower(?)').get(id));

// ---- "Send Link" reset tokens ----

export function insertResetToken({ tokenHash, userId, expiresAt, createdBy }) {
    // Only the newest link works: older unused links for this user are retired.
    db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(nowIso(), userId);
    db.prepare('INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(tokenHash, userId, expiresAt, createdBy ?? null, nowIso());
}

export const findResetToken = (tokenHash) => db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash = ?').get(tokenHash);

export const markResetTokenUsed = (tokenHash) => db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash);
