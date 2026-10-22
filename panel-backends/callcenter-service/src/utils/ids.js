import { randomBytes, createHash } from 'node:crypto';
import { db } from '../db/database.js';

/** Next id like `${prefix}-<number>` (DOC-1001, COM-1001); `start` is the number before the first one. */
export function nextSequentialId(table, prefix, start = 1000) {
    const row = db.prepare(`SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS n FROM ${table} WHERE id GLOB ?`)
        .get(prefix.length + 2, `${prefix}-[0-9]*`);
    return `${prefix}-${Math.max(start, row.n ?? 0) + 1}`;
}

/** YYMMDD of a date (local server time). */
export const yymmdd = (d = new Date()) =>
    `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/** Next number of a daily series like LET-251021-001 (`width` digits). */
export function nextDailyId(table, prefix, width = 3, start = 0) {
    const day = `${prefix}-${yymmdd()}`;
    const row = db.prepare(`SELECT MAX(CAST(substr(id, ?) AS INTEGER)) AS n FROM ${table} WHERE id GLOB ?`)
        .get(day.length + 2, `${day}-[0-9]*`);
    return `${day}-${String(Math.max(start, row.n ?? 0) + 1).padStart(width, '0')}`;
}

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
