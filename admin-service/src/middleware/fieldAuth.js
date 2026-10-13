import { verifyToken } from '../utils/jwt.js';
import { settings } from '../config.js';
import { findUser } from '../models/userModel.js';

// Field app (Pre-Inspection Agent app) sign-in. Field users are the people
// created in Admin > Create Users; their tokens carry kind: 'field' and are
// never accepted by the admin console's own routes (and vice versa).

/** Roles that may sign in on each tab of the app's login screen. */
export const FIELD_ROLES = {
    agent: ['preinspection-agent'],
    surveyor: ['preinspection-surveyor', 'internal-surveyor', 'external-surveyor'],
};

/** Verifies `Authorization: Bearer <field token>`, re-loads the user every request. Sets req.fieldUser. */
export function fieldAuth(req, res, next) {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) return res.status(401).json({ detail: 'Please sign in.' });
    let claims;
    try {
        claims = verifyToken(token, settings.jwtSecret);
    } catch (err) {
        return res.status(401).json({ detail: err.message === 'Token expired' ? 'Session expired, please sign in again.' : 'Invalid session, please sign in again.' });
    }
    if (claims.kind !== 'field') return res.status(401).json({ detail: 'Invalid session, please sign in again.' });
    const user = findUser(claims.sub);
    if (!user || user.status !== 'Active' || !FIELD_ROLES[claims.role]?.includes(user.roleKey)) {
        return res.status(401).json({ detail: 'This account can no longer use the app. Contact your admin.' });
    }
    req.fieldUser = { ...user, appRole: claims.role };
    return next();
}
