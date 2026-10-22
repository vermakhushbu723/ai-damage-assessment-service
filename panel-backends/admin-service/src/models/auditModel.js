import { db, nowIso } from '../db/database.js';
import { nextSequentialId } from '../utils/ids.js';

// Two trails, both shown on Audit Logs:
//  - changes: "Recent Configuration Changes" (who changed what, old -> new)
//  - audit_events: security / session events (sign-in, failed sign-in, resets, exports)

const toChange = (r) => ({
    id: r.id, changedBy: r.changed_by, module: r.module, change: r.change, oldValue: r.old_value, newValue: r.new_value,
    changedOn: r.changed_on, device: [r.ip, r.device].filter(Boolean).join(' / ') || null,
});

export const listChanges = (limit = 2000) => db.prepare('SELECT * FROM changes ORDER BY changed_on DESC, id DESC LIMIT ?').all(limit).map(toChange);

export function insertChange({ changedBy, changedById, module, change, oldValue, newValue, ip, device }) {
    const id = nextSequentialId('changes', 'CHG', 1000);
    db.prepare(`INSERT INTO changes (id, changed_by, changed_by_id, module, change, old_value, new_value, ip, device, changed_on)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, changedBy, changedById ?? null, module, change, oldValue, newValue, ip ?? null, device ?? null, nowIso());
    return toChange(db.prepare('SELECT * FROM changes WHERE id = ?').get(id));
}

const toEvent = (r) => ({
    id: `AUD-${r.id}`, at: r.at, user: r.user, role: r.role ?? '—', update: r.update_text, reference: r.reference,
    device: [r.ip, r.device].filter(Boolean).join(' / ') || '—', module: r.module, status: r.status, detail: r.detail,
});

export const listAuditEvents = (limit = 2000) => db.prepare('SELECT * FROM audit_events ORDER BY at DESC, id DESC LIMIT ?').all(limit).map(toEvent);

export function insertAuditEvent({ actorId, user, role, update, reference, module, status, detail, ip, device }) {
    db.prepare(`INSERT INTO audit_events (at, actor_id, user, role, update_text, reference, module, status, detail, ip, device)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(nowIso(), actorId ?? null, user, role ?? null, update, reference, module, status, detail ?? null, ip ?? null, device ?? null);
}

/** Retention policy ("7 Years" -> 7): deletes older audit events and changes. */
export function purgeOlderThan(retention) {
    const years = Number(String(retention).split(' ')[0]) || 7;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - years);
    const iso = cutoff.toISOString();
    return db.prepare('DELETE FROM audit_events WHERE at < ?').run(iso).changes + db.prepare('DELETE FROM changes WHERE changed_on < ?').run(iso).changes;
}
