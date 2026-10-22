import { insertAuditEvent, insertChange } from '../models/auditModel.js';
import { getSetting } from '../models/settingsModel.js';

// "Chrome / Windows" style device label from the User-Agent header.
export function deviceOf(userAgent = '') {
    const browser = /Edg\//.test(userAgent) ? 'Edge' : /OPR\//.test(userAgent) ? 'Opera' : /Chrome\//.test(userAgent) ? 'Chrome'
        : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Other';
    const os = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS'
        : /Mac OS/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : 'Other';
    return `${browser} / ${os}`;
}

// Real client IP behind nginx (X-Forwarded-For), without the IPv6 "::ffff:" prefix.
export function ipOf(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return (forwarded || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

const SESSION_REFERENCES = ['Login', 'Logout', 'Failed Login'];

/**
 * Security / session event (Audit Logs). `actor` defaults to the signed-in
 * admin; pass one for sign-ins (no req.admin yet).
 * update = the "Update" column, reference = the action (Login, Password Reset, Exported, ...).
 */
export function auditEvent(req, { update, reference, module, status = 'Success', detail = null, actor = req.admin }) {
    // System Settings > Audit login OFF: sign-ins/outs are not recorded.
    if (SESSION_REFERENCES.includes(reference) && !getSetting('compliance').auditLogin) return;
    insertAuditEvent({
        actorId: actor?.id ?? null,
        user: actor?.name ?? 'Unknown',
        role: actor?.role ?? null,
        update,
        reference,
        module,
        status,
        detail,
        ip: ipOf(req),
        device: deviceOf(req.headers['user-agent']),
    });
}

/** One row of "Recent Configuration Changes", stamped with the signed-in admin. */
export function logChange(req, { module, change, oldValue = '—', newValue = '—' }) {
    return insertChange({
        changedBy: req.admin?.name ?? 'System',
        changedById: req.admin?.id ?? null,
        module,
        change,
        oldValue: String(oldValue ?? '—'),
        newValue: String(newValue ?? '—'),
        ip: ipOf(req),
        device: deviceOf(req.headers['user-agent']),
    });
}
