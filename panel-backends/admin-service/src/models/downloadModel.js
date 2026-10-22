import { db, nowIso, parseJson } from '../db/database.js';

// Data Download history (table `downloads`); `content` is the generated file.

export const toDownloadDto = (r) => ({
    id: r.id,
    fileName: r.file_name,
    dataType: r.data_type,
    format: r.format,
    spec: parseJson(r.params, {}),
    rows: r.rows,
    sizeKb: Math.max(0.1, Math.round((r.size_bytes / 1024) * 10) / 10),
    by: r.created_by_name,
    at: r.created_at,
    expiresAt: r.expires_at,
    status: new Date(r.expires_at) > new Date() ? 'Ready' : 'Expired',
});

export const listDownloads = () => db.prepare('SELECT * FROM downloads ORDER BY created_at DESC, id DESC').all().map(toDownloadDto);
export const findDownloadRow = (id) => db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);

export function insertDownload({ id, fileName, dataType, format, params, rows, content, createdBy, createdByName, expiresAt }) {
    db.prepare(`INSERT INTO downloads (id, file_name, data_type, format, params, rows, size_bytes, content, created_by, created_by_name, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, fileName, dataType, format, JSON.stringify(params), rows, Buffer.byteLength(content), content, createdBy ?? null, createdByName, nowIso(), expiresAt);
    return toDownloadDto(findDownloadRow(id));
}

/** Expired files keep their history row but drop the content. */
export const dropExpiredContent = () => db.prepare("UPDATE downloads SET content = '' WHERE expires_at < ? AND content <> ''").run(nowIso()).changes;
