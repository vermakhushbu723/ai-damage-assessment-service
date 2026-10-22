import { db, nowIso } from '../db/database.js';
import { nextSequentialId } from '../utils/ids.js';

// Contact enquiries from the IBima Assist app (table `enquiries`).

const toEnquiry = (r) => (r ? {
    id: r.id,
    name: r.name,
    organisation: r.organisation,
    email: r.email,
    phone: r.phone,
    orgType: r.org_type,
    interest: r.interest,
    message: r.message,
    status: r.status,
    notes: r.notes,
    source: r.source,
    sourcePage: r.source_page,
    ip: r.ip,
    userAgent: r.user_agent,
    handledBy: r.handled_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
} : null);

export const listEnquiries = () => db.prepare('SELECT * FROM enquiries ORDER BY created_at DESC, id DESC').all().map(toEnquiry);
export const findEnquiry = (id) => toEnquiry(db.prepare('SELECT * FROM enquiries WHERE id = ?').get(id));

export function insertEnquiry(e) {
    const id = nextSequentialId('enquiries', 'ENQ', 1000);
    const now = nowIso();
    db.prepare(`INSERT INTO enquiries (id, name, organisation, email, phone, org_type, interest, message, source, source_page, ip, user_agent, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, e.name, e.organisation, e.email, e.phone, e.orgType || null, e.interest || null, e.message, e.source, e.sourcePage ?? null, e.ip ?? null, e.userAgent ?? null, now, now);
    return findEnquiry(id);
}

/** Status / notes from the admin panel. */
export function updateEnquiry(id, { status, notes, handledBy }) {
    const current = findEnquiry(id);
    if (!current) return null;
    db.prepare('UPDATE enquiries SET status = ?, notes = ?, handled_by = ?, updated_at = ? WHERE id = ?')
        .run(status ?? current.status, notes !== undefined ? notes : current.notes, handledBy ?? current.handledBy, nowIso(), id);
    return findEnquiry(id);
}

export const deleteEnquiry = (id) => db.prepare('DELETE FROM enquiries WHERE id = ?').run(id).changes > 0;

// ---- Documents DMS: files attached to an enquiry (table `enquiry_files`) ----
const toFile = (r) => ({
    id: r.id, docType: r.doc_type, name: r.original_name, mime: r.mime, sizeBytes: r.size_bytes, uploadedBy: r.uploaded_by, uploadedAt: r.created_at,
});

export const listEnquiryFiles = (enquiryId) =>
    db.prepare('SELECT * FROM enquiry_files WHERE enquiry_id = ? ORDER BY created_at DESC').all(enquiryId).map(toFile);

export const findEnquiryFileRow = (enquiryId, fileId) =>
    db.prepare('SELECT * FROM enquiry_files WHERE enquiry_id = ? AND id = ?').get(enquiryId, fileId);

/** Every file of an enquiry (for removing them from disk when the enquiry is deleted). */
export const enquiryFileNames = (enquiryId) =>
    db.prepare('SELECT file_name FROM enquiry_files WHERE enquiry_id = ?').all(enquiryId).map((r) => r.file_name);

export function insertEnquiryFile({ id, enquiryId, docType, originalName, mime, sizeBytes, fileName, uploadedBy }) {
    db.prepare(`INSERT INTO enquiry_files (id, enquiry_id, doc_type, original_name, mime, size_bytes, file_name, uploaded_by, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, enquiryId, docType, originalName, mime, sizeBytes, fileName, uploadedBy ?? null, nowIso());
    return toFile(findEnquiryFileRow(enquiryId, id));
}

export const deleteEnquiryFileRow = (enquiryId, fileId) =>
    db.prepare('DELETE FROM enquiry_files WHERE enquiry_id = ? AND id = ?').run(enquiryId, fileId).changes > 0;
