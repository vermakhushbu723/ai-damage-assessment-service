import { randomBytes, randomInt, createHash } from 'node:crypto';
import { db } from '../db/database.js';

/**
 * Next sequential ID for a table whose ids look like `${prefix}-<number>`
 * (ORG-1001, USR-1001, ADM-101). `start` is the number before the first one.
 */
export function nextSequentialId(table, prefix, start) {
    const rows = db.prepare(`SELECT id FROM ${table} WHERE id LIKE ?`).all(`${prefix}-%`);
    const re = new RegExp(`^${prefix}-(\\d+)$`);
    const max = rows.reduce((m, r) => Math.max(m, Number(re.exec(r.id)?.[1] ?? 0)), start);
    return `${prefix}-${max + 1}`;
}

const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
/** Random temporary password that always passes the password policy (letters + digits + symbol). */
export function generatePassword(length = 12) {
    const body = Array.from({ length: length - 2 }, () => PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)]).join('');
    return `${body}${randomInt(10)}@`;
}

export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
