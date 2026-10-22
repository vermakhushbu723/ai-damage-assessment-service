import { randomBytes } from 'node:crypto';
import { db, nowIso, parseJson } from '../db/database.js';
import { nextSequentialId } from '../utils/ids.js';

// Pre-inspections from the Pre-Inspection Agent app (tables `inspections`,
// `inspection_media`). Files live on disk (services/mediaStore.js); rows here
// point at them.

function toInspection(row, { agents } = {}) {
    if (!row) return null;
    const data = parseJson(row.data, {});
    return {
        ...data,
        id: row.id,
        agentId: row.agent_id,
        agentName: agents?.[row.agent_id]?.name ?? null,
        agentUserId: agents?.[row.agent_id]?.userId ?? null,
        agentRole: row.agent_role,
        status: row.status,
        registrationNumber: row.registration_number,
        ownerName: row.owner_name,
        workflow: row.workflow,
        submittedAt: row.submitted_at,
        repairSubmittedAt: row.repair_submitted_at,
        reviewedAt: row.reviewed_at,
        reviewedBy: row.reviewed_by,
        reviewRemarks: row.review_remarks,
        assignedBy: row.assigned_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

const agentLookup = () => Object.fromEntries(db.prepare('SELECT id, name, user_id FROM users').all().map((u) => [u.id, { name: u.name, userId: u.user_id }]));

/** All inspections (admin) or one agent's (app), newest first, with media counts. */
export function listInspections({ agentId } = {}) {
    const rows = agentId
        ? db.prepare('SELECT * FROM inspections WHERE agent_id = ? ORDER BY created_at DESC').all(agentId)
        : db.prepare('SELECT * FROM inspections ORDER BY created_at DESC').all();
    const byInspection = {};
    for (const r of db.prepare('SELECT inspection_id, kind, COUNT(*) AS n FROM inspection_media GROUP BY inspection_id, kind').all()) {
        (byInspection[r.inspection_id] ??= {})[r.kind] = r.n;
    }
    const agents = agentLookup();
    return rows.map((r) => ({ ...toInspection(r, { agents }), mediaCounts: byInspection[r.id] ?? {} }));
}

export function findInspection(id) {
    return toInspection(db.prepare('SELECT * FROM inspections WHERE id = ?').get(id), { agents: agentLookup() });
}

const COLUMN_FIELDS = ['registrationNumber', 'ownerName', 'workflow'];
const dataOf = (fields) => Object.fromEntries(Object.entries(fields).filter(([k]) => !COLUMN_FIELDS.includes(k)));

export function insertInspection({ agentId, agentRole, fields, status = 'Draft', assignedBy = null }) {
    const id = nextSequentialId('inspections', 'PI', 100000);
    const now = nowIso();
    db.prepare(`INSERT INTO inspections (id, agent_id, agent_role, status, registration_number, owner_name, workflow, data, assigned_by, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, agentId, agentRole, status, fields.registrationNumber, fields.ownerName, fields.workflow ?? null, JSON.stringify(dataOf(fields)), assignedBy, now, now);
    return findInspection(id);
}

/** Merges form fields into the inspection. */
export function updateInspection(id, fields) {
    const row = db.prepare('SELECT * FROM inspections WHERE id = ?').get(id);
    if (!row) return null;
    const data = { ...parseJson(row.data, {}), ...dataOf(fields) };
    db.prepare('UPDATE inspections SET registration_number = ?, owner_name = ?, workflow = ?, data = ?, updated_at = ? WHERE id = ?').run(
        fields.registrationNumber ?? row.registration_number,
        fields.ownerName ?? row.owner_name,
        fields.workflow !== undefined ? fields.workflow : row.workflow,
        JSON.stringify(data), nowIso(), id,
    );
    return findInspection(id);
}

export function setInspectionStatus(id, status, extra = {}) {
    const sets = ['status = ?', 'updated_at = ?'];
    const vals = [status, nowIso()];
    for (const [col, v] of Object.entries(extra)) {
        sets.push(`${col} = ?`);
        vals.push(v);
    }
    db.prepare(`UPDATE inspections SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return findInspection(id);
}

export function setInspectionAgent(id, agentId, agentRole) {
    db.prepare('UPDATE inspections SET agent_id = ?, agent_role = ?, updated_at = ? WHERE id = ?').run(agentId, agentRole, nowIso(), id);
    return findInspection(id);
}

export const deleteInspection = (id) => db.prepare('DELETE FROM inspections WHERE id = ?').run(id).changes > 0;

/** Assigned (not started) and Draft (in progress) are still with the agent. */
export const isOpen = (i) => ['Assigned', 'Draft'].includes(i.status);

export const countInspectionsForAgent = (agentId) => db.prepare('SELECT COUNT(*) AS n FROM inspections WHERE agent_id = ?').get(agentId).n;

// ---- media ----
const toMedia = (r) => ({
    id: r.id, kind: r.kind, slot: r.slot, mime: r.mime, sizeBytes: r.size_bytes,
    latitude: r.latitude, longitude: r.longitude, capturedAt: r.captured_at, uploadedAt: r.created_at,
});

export const listMedia = (inspectionId) =>
    db.prepare('SELECT * FROM inspection_media WHERE inspection_id = ? ORDER BY kind, slot').all(inspectionId).map(toMedia);

export const findMediaRow = (inspectionId, mediaId) =>
    db.prepare('SELECT * FROM inspection_media WHERE inspection_id = ? AND id = ?').get(inspectionId, mediaId);

export const findMediaRowBySlot = (inspectionId, kind, slot) =>
    db.prepare('SELECT * FROM inspection_media WHERE inspection_id = ? AND kind = ? AND slot = ?').get(inspectionId, kind, slot);

/** Inserts or replaces the file of (inspection, kind, slot). Returns { media, replacedFile }. */
export function upsertMedia({ inspectionId, kind, slot, mime, sizeBytes, fileName, latitude, longitude, capturedAt }) {
    const existing = findMediaRowBySlot(inspectionId, kind, slot);
    const now = nowIso();
    if (existing) {
        db.prepare(`UPDATE inspection_media SET mime = ?, size_bytes = ?, file_name = ?, latitude = ?, longitude = ?, captured_at = ?, created_at = ?
                    WHERE id = ?`).run(mime, sizeBytes, fileName, latitude ?? null, longitude ?? null, capturedAt ?? null, now, existing.id);
        return { media: toMedia(findMediaRow(inspectionId, existing.id)), replacedFile: existing.file_name !== fileName ? existing.file_name : null };
    }
    const id = randomBytes(9).toString('base64url');
    db.prepare(`INSERT INTO inspection_media (id, inspection_id, kind, slot, mime, size_bytes, file_name, latitude, longitude, captured_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, inspectionId, kind, slot, mime, sizeBytes, fileName, latitude ?? null, longitude ?? null, capturedAt ?? null, now);
    return { media: toMedia(findMediaRow(inspectionId, id)), replacedFile: null };
}

export function deleteMediaRow(inspectionId, mediaId) {
    const row = findMediaRow(inspectionId, mediaId);
    if (!row) return null;
    db.prepare('DELETE FROM inspection_media WHERE id = ?').run(mediaId);
    return row;
}

export const countMedia = (inspectionId, kind) =>
    db.prepare('SELECT COUNT(*) AS n FROM inspection_media WHERE inspection_id = ? AND kind = ?').get(inspectionId, kind).n;
