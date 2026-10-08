import { db, nowIso } from '../db/database.js';

const toDto = (r) => r && ({
    id: r.id,
    fileName: r.file_name,
    dataType: r.data_type,
    format: r.format,
    params: JSON.parse(r.params || '{}'),
    rows: r.row_count,
    sizeBytes: r.size_bytes,
    generatedBy: r.created_by_name,
    generatedById: r.created_by,
    generatedOn: r.created_at,
    expiresAt: r.expires_at,
    status: r.content != null && new Date(r.expires_at) > new Date() ? 'Ready' : 'Expired',
});

const COLS = 'id, file_name, data_type, format, params, row_count, size_bytes, created_by, created_by_name, created_at, expires_at, (content IS NOT NULL) AS has_content';

export function listDownloads() {
    return db.prepare(`SELECT ${COLS} FROM downloads ORDER BY created_at DESC`).all()
        .map((r) => toDto({ ...r, content: r.has_content ? '' : null }));
}

export const findDownloadRow = (id) => db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
export const toDownloadDto = toDto;

export function insertDownload(d) {
    db.prepare(`INSERT INTO downloads (id, file_name, data_type, format, params, row_count, size_bytes, content, created_by, created_by_name, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        d.id, d.fileName, d.dataType, d.format, JSON.stringify(d.params ?? {}), d.rows, d.sizeBytes, d.content,
        d.createdBy ?? null, d.createdByName ?? null, nowIso(), d.expiresAt,
    );
    return toDto(findDownloadRow(d.id));
}

/** Frees the stored CSV of expired downloads (the history row stays, shown as Expired). */
export const purgeExpiredDownloads = () =>
    db.prepare('UPDATE downloads SET content = NULL WHERE content IS NOT NULL AND expires_at < ?').run(nowIso()).changes;
