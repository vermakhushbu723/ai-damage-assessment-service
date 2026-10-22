import { verifyToken } from '../utils/jwt.js';
import { settings } from '../config.js';

/**
 * Reads `Authorization: Bearer <token>`, verifies it, and attaches the
 * decoded claims as req.auth = { sub, role, username, name, iat, exp }.
 * 401s with a clear reason if missing/invalid/expired.
 */
export function authenticate(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ detail: 'Missing or malformed Authorization header (expected "Bearer <token>").' });
    }

    try {
        req.auth = verifyToken(token, settings.jwtSecret);
        return next();
    } catch (err) {
        return res.status(401).json({ detail: err.message === 'Token expired' ? 'Session expired, please log in again.' : 'Invalid token.' });
    }
}

/**
 * Optional extra guard for a route that should only ever be hit by one
 * specific portal, e.g. requireRole(ROLES.CLAIM_WORKSHOP). Not used by
 * auth.js itself (login/me are role-agnostic), but available for any
 * future route another service adds that's meant to be portal-specific.
 */
export function requireRole(...allowedRoles) {
    return (req, res, next) => {
        if (!req.auth || !allowedRoles.includes(req.auth.role)) {
            return res.status(403).json({ detail: 'This portal is not allowed to access this resource.' });
        }
        return next();
    };
}
