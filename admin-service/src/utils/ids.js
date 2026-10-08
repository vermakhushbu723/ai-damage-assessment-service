import { randomBytes, randomInt, createHash } from 'node:crypto';
import { db } from '../db/database.js';

/**
 * Next sequential ID for ids like `${prefix}-<number>` (USR-1001, CHG-1001).
 * `start` is the number before the first one. For the shared `records`
 * table pass `collection` so each list numbers on its own.
 */
export function nextSequentialId(table, prefix, start, collection = null) {
    const where = collection ? 'AND collection = ?' : '';
    const params = collection ? [collection] : [];
    const row = db.prepare(`SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS n FROM ${table} WHERE id GLOB ? ${where}`)
        .get(prefix.length + 2, `${prefix}-[0-9]*`, ...params);
    return `${prefix}-${Math.max(start, row.n ?? 0) + 1}`;
}

const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
/** Random temporary password that always passes the password policy (letters + digits + symbol). */
export function generatePassword(length = 12) {
    const body = Array.from({ length: length - 2 }, () => PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)]).join('');
    return `${body}${randomInt(10)}@`;
}

export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
