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
