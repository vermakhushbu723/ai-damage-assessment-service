import { randomUUID } from 'node:crypto';
import { db } from '../db/database.js';

export function findUserByRoleAndUsername(role, username) {
    return db.prepare('SELECT * FROM users WHERE role = ? AND username = ? AND active = 1').get(role, username);
}

export function findUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id);
}

export function createUser({ role, username, passwordHash, name }) {
    const id = randomUUID();
    db.prepare(
        'INSERT INTO users (id, role, username, password_hash, name) VALUES (?, ?, ?, ?, ?)'
    ).run(id, role, username, passwordHash, name);
    return findUserById(id);
}

export function touchLastLogin(id) {
    db.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
}

/** Strips the password hash before a user row goes anywhere near a response. */
export function toPublicUser(user) {
    if (!user) return null;
    const { password_hash, ...publicUser } = user;
    return {
        id: publicUser.id,
        role: publicUser.role,
        username: publicUser.username,
        name: publicUser.name,
        createdAt: publicUser.created_at,
        lastLoginAt: publicUser.last_login_at,
    };
}
