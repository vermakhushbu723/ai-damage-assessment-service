import { db, nowIso, parseJson } from '../db/database.js';
import { OPEN_STAGES, CLOSED_STAGES, DEFAULT_CAPACITY } from '../constants.js';

// Users created in Create Users (table `users`) + Send Link tokens (`reset_tokens`).
// Searchable / unique fields are columns; the rest of the form is `data` JSON.

/** Claim load per handler from the claims pushed by the claim systems. */
function handlerCounts() {
    const placeholders = (arr) => arr.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT handler_id,
            COUNT(*) AS total,
            SUM(CASE WHEN stage IN (${placeholders(OPEN_STAGES)}) THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN stage IN (${placeholders(CLOSED_STAGES)}) THEN 1 ELSE 0 END) AS closed
        FROM claims WHERE handler_id IS NOT NULL GROUP BY handler_id`).all(...OPEN_STAGES, ...CLOSED_STAGES);
    return Object.fromEntries(rows.map((r) => [r.handler_id, r]));
}

/** `withImage`: include the profile image data URL (only the single-user read does -- lists stay small). */
function toUser(row, counts, { withImage = false } = {}) {
    const data = parseJson(row.data, {});
    const { capacityLimit = DEFAULT_CAPACITY, profileImage, ...rest } = data;
    const c = counts?.[row.id];
    return {
        ...rest,
        ...(withImage ? { profileImage: profileImage ?? null } : {}),
        hasProfileImage: !!profileImage,
        id: row.id,
        userId: row.user_id,
        name: row.name,
        email: row.email,
        employeeId: row.employee_id,
        contact: row.contact,
        roleKey: row.role_key,
        status: row.status,
        organization: row.organization,
        handlerStats: {
            totalClaims: c?.total ?? 0,
            inProgress: c?.open ?? 0,
            completed: c?.closed ?? 0,
            capacityLimit,
        },
        mustChangePassword: !!row.must_change_password,
        passwordResetAt: row.password_reset_at,
        lastResetLinkAt: row.last_reset_link_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export const listUsers = () => {
    const counts = handlerCounts();
    return db.prepare('SELECT * FROM users ORDER BY created_at DESC, id DESC').all().map((r) => toUser(r, counts));
};

export const findUserRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
export function findUser(id, opts) {
    const row = findUserRow(id);
    return row ? toUser(row, handlerCounts(), opts) : null;
}
export function findUserByLogin(userId) {
    const row = db.prepare('SELECT * FROM users WHERE lower(user_id) = lower(?)').get(String(userId ?? '').trim());
    return row ? toUser(row, handlerCounts()) : null;
}

/** First user (other than `exceptId`) already holding this value, or undefined. */
export function findDuplicate(field, value, exceptId = '') {
    const column = { userId: 'user_id', email: 'email', employeeId: 'employee_id' }[field];
    return db.prepare(`SELECT id, name FROM users WHERE lower(${column}) = lower(?) AND id <> ?`).get(String(value).trim(), exceptId);
}

export function findByAgentCode(code, exceptId = '') {
    return db.prepare("SELECT id, name FROM users WHERE json_extract(data, '$.extra.agentCode') = ? AND id <> ?").get(code, exceptId);
}

const COLUMN_FIELDS = ['userId', 'name', 'email', 'employeeId', 'contact', 'roleKey', 'status', 'organization'];
const split = (user) => {
    const data = {};
    for (const [k, v] of Object.entries(user)) if (!COLUMN_FIELDS.includes(k)) data[k] = v;
    return data;
};

export function insertUser(user, { passwordHash, createdBy }) {
    const now = nowIso();
    db.prepare(`INSERT INTO users (id, user_id, name, email, employee_id, contact, role_key, status, organization, data, password_hash, created_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        user.id, user.userId, user.name, user.email, user.employeeId, user.contact ?? null, user.roleKey, user.status, user.organization ?? null,
        JSON.stringify(split(user)), passwordHash, createdBy ?? null, now, now,
    );
    return findUser(user.id);
}

/** Merges `patch` (form fields) into the user. */
export function updateUser(id, patch) {
    const row = findUserRow(id);
    if (!row) return null;
    const current = { ...parseJson(row.data, {}), userId: row.user_id, name: row.name, email: row.email, employeeId: row.employee_id, contact: row.contact, roleKey: row.role_key, status: row.status, organization: row.organization };
    const next = { ...current, ...patch };
    db.prepare(`UPDATE users SET user_id = ?, name = ?, email = ?, employee_id = ?, contact = ?, role_key = ?, status = ?, organization = ?, data = ?, updated_at = ?
                WHERE id = ?`).run(next.userId, next.name, next.email, next.employeeId, next.contact ?? null, next.roleKey, next.status, next.organization ?? null,
        JSON.stringify(split(next)), nowIso(), id);
    return findUser(id);
}

export function setUserStatus(ids, status) {
    const stmt = db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?');
    const now = nowIso();
    return ids.reduce((n, id) => n + stmt.run(status, now, id).changes, 0);
}

export function setUserPassword(id, passwordHash, { mustChange = true } = {}) {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, password_reset_at = ?, updated_at = ? WHERE id = ?')
        .run(passwordHash, mustChange ? 1 : 0, nowIso(), nowIso(), id);
}

export const countUsersWithRole = (roleKey) => db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_key = ?').get(roleKey).n;

// ---- Send Link tokens ----
export function insertResetToken({ tokenHash, userId, expiresAt, createdBy }) {
    // A new link replaces any unused older one.
    db.prepare('DELETE FROM reset_tokens WHERE user_id = ? AND used_at IS NULL').run(userId);
    db.prepare('INSERT INTO reset_tokens (token_hash, user_id, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(tokenHash, userId, expiresAt, createdBy ?? null, nowIso());
    db.prepare('UPDATE users SET last_reset_link_at = ? WHERE id = ?').run(nowIso(), userId);
}

export const findResetToken = (tokenHash) => db.prepare('SELECT * FROM reset_tokens WHERE token_hash = ?').get(tokenHash);
export const markResetTokenUsed = (tokenHash) => db.prepare('UPDATE reset_tokens SET used_at = ? WHERE token_hash = ?').run(nowIso(), tokenHash);
