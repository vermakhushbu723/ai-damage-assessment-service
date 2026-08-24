import { verifyToken } from '../utils/jwt.js';
import { settings } from '../config.js';

/**
 * Reads `Authorization: Bearer <token>` (issued by ../auth-service),
 * verifies it, and attaches the decoded claims as
 * req.auth = { sub, role, username, name, iat, exp }. Every route in this
 * service uses req.auth.role + req.auth.sub to scope data to the calling
 * portal/user -- see routes/claims.js.
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
