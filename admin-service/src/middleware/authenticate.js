import { timingSafeEqual } from 'node:crypto';
import { verifyToken } from '../utils/jwt.js';
import { settings } from '../config.js';
import { findAdminById } from '../models/adminModel.js';

/**
 * Verifies `Authorization: Bearer <token>` and re-loads the admin from the
 * database on every request, so a suspended account stops working at once.
 * Sets req.admin = { id, name, email, role, ... }.
 */
export function authenticate(req, res, next) {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ detail: 'Please sign in.' });
    }
    let claims;
    try {
        claims = verifyToken(token, settings.jwtSecret);
    } catch (err) {
        return res.status(401).json({ detail: err.message === 'Token expired' ? 'Session expired, please sign in again.' : 'Invalid session, please sign in again.' });
    }
    const admin = findAdminById(claims.sub);
    if (!admin || admin.status !== 'Active') {
        return res.status(401).json({ detail: 'This account is no longer active.' });
    }
    req.admin = admin;
    return next();
}

/** True when the request carries the claim systems' X-Service-Key. */
export function hasServiceKey(req) {
    const key = String(req.headers['x-service-key'] || '');
    if (!settings.claimsIngestKey || !key) return false;
    const a = Buffer.from(key);
    const b = Buffer.from(settings.claimsIngestKey);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** X-Service-Key (claim systems) or a signed-in admin. */
export function serviceKeyOrAdmin(req, res, next) {
    if (hasServiceKey(req)) {
        req.admin = { id: null, name: 'Claim System', role: 'Service' };
        return next();
    }
    return authenticate(req, res, next);
}
