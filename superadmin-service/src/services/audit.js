import { insertAuditLog } from '../models/auditModel.js';

// "Chrome / Windows" style device label from the User-Agent header.
function deviceOf(userAgent = '') {
    const browser = /Edg\//.test(userAgent) ? 'Edge' : /OPR\//.test(userAgent) ? 'Opera' : /Chrome\//.test(userAgent) ? 'Chrome'
        : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Other';
    const os = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS'
        : /Mac OS/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : 'Other';
    return `${browser} / ${os}`;
}

// Real client IP behind nginx (X-Forwarded-For), without the IPv6 "::ffff:" prefix.
function ipOf(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return (forwarded || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

/**
 * Records one audit entry for the current request. `actor` defaults to the
 * signed-in admin; pass one explicitly for logins (no req.admin yet).
 */
export function audit(req, { action, module, status = 'Success', detail = null, actor = req.admin }) {
    insertAuditLog({
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? 'Unknown',
        actorRole: actor?.role ?? null,
        action,
        module,
        status,
        detail,
        ip: ipOf(req),
        device: deviceOf(req.headers['user-agent']),
    });
}
