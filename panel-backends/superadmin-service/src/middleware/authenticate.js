import { verifyToken } from '../utils/jwt.js';
import { settings } from '../config.js';
import { findAdminById } from '../models/adminUserModel.js';
import { MASTER_ROLE, SERVICE_MODEL_OF_SCOPE } from '../constants.js';

/**
 * Verifies `Authorization: Bearer <token>` and re-loads the admin from the
 * database on every request, so a suspended admin (or a changed role/scope)
 * takes effect immediately instead of when the token expires.
 * Sets req.admin = { id, name, email, role, scope, ... }.
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

/** Master super admin = role "Super Admin" with scope "all". Manages admins and roles. */
export const isMaster = (admin) => admin?.role === MASTER_ROLE && admin?.scope === 'all';

export function requireMaster(req, res, next) {
    if (!isMaster(req.admin)) {
        return res.status(403).json({ detail: 'Only the master Super Admin can do this.' });
    }
    return next();
}

/** null = sees every service model; otherwise the single service model this admin manages. */
export const serviceModelOfAdmin = (admin) => (admin.scope === 'all' ? null : SERVICE_MODEL_OF_SCOPE[admin.scope] ?? '__none__');
