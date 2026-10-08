import { db, nowIso, parseJson } from '../db/database.js';

// Generic storage for the configuration lists (table `records`). Every item
// is a JSON object with an `id`; `collection` keeps the lists apart.

const toItem = (row) => ({ ...parseJson(row.data, {}), id: row.id, createdAt: row.created_at, updatedAt: row.updated_at });

/** Newest first by default (the portal lists new items on top); `order: 'asc'` keeps insertion order. */
export function listRecords(collection, { order = 'desc' } = {}) {
    return db.prepare(`SELECT * FROM records WHERE collection = ? ORDER BY position ${order === 'asc' ? 'ASC' : 'DESC'}`).all(collection).map(toItem);
}

export function findRecord(collection, id) {
    const row = db.prepare('SELECT * FROM records WHERE collection = ? AND id = ?').get(collection, id);
    return row ? toItem(row) : null;
}

export const countRecords = (collection) => db.prepare('SELECT COUNT(*) AS n FROM records WHERE collection = ?').get(collection).n;

const strip = ({ id: _id, createdAt: _c, updatedAt: _u, ...rest }) => rest;

export function insertRecord(collection, item) {
    const now = nowIso();
    const position = (db.prepare('SELECT MAX(position) AS p FROM records WHERE collection = ?').get(collection).p ?? 0) + 1;
    db.prepare('INSERT INTO records (collection, id, data, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(collection, item.id, JSON.stringify(strip(item)), position, now, now);
    return findRecord(collection, item.id);
}

/** Shallow-merges `patch` into the stored item. */
export function updateRecord(collection, id, patch) {
    const current = findRecord(collection, id);
    if (!current) return null;
    const next = { ...strip(current), ...strip(patch) };
    db.prepare('UPDATE records SET data = ?, updated_at = ? WHERE collection = ? AND id = ?').run(JSON.stringify(next), nowIso(), collection, id);
    return findRecord(collection, id);
}

export const deleteRecord = (collection, id) => db.prepare('DELETE FROM records WHERE collection = ? AND id = ?').run(collection, id).changes > 0;
