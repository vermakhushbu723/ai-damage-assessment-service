import { verifyToken } from '../utils/jwt.js';
import { settings } from '../config.js';
import { getUser } from '../services/adminClient.js';
import { HttpError } from '../utils/http.js';

/**
 * Verifies `Authorization: Bearer <token>` (issued by POST /auth/login) and
 * re-checks the user against admin-service (cached USER_CACHE_SECONDS), so a
 * suspended account, a removed web access or a changed role takes effect
 * within seconds. Sets req.user = { id, name, roleKey, permissions, ... }.
 */
export async function authenticate(req, res, next) {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) return res.status(401).json({ detail: 'Please sign in.' });
    let claims;
    try {
        claims = verifyToken(token, settings.jwtSecret);
    } catch (err) {
        return res.status(401).json({ detail: err.message === 'Token expired' ? 'Session expired, please sign in again.' : 'Invalid session, please sign in again.' });
    }
    if (claims.kind !== 'callcenter') return res.status(401).json({ detail: 'Invalid session, please sign in again.' });
    try {
        const user = await getUser(claims.sub);
        if (!user) return res.status(401).json({ detail: 'This account no longer exists.' });
        if (user.blocked) return res.status(401).json({ detail: user.blocked });
        req.user = user;
        return next();
    } catch (err) {
        return next(err);
    }
}

/** True when the user's role allows `action` (view | edit | create | approve | download) on `module`. */
export const allowed = (user, module, action = 'view') => !!user?.permissions?.[module]?.[action];

/** Route guard: the role must allow `action` on one of `modules`. */
export function can(modules, action = 'view') {
    const list = Array.isArray(modules) ? modules : [modules];
    return (req, _res, next) => {
        if (list.some((m) => allowed(req.user, m, action))) return next();
        return next(new HttpError(403, `Your role (${req.user?.roleName ?? 'unknown'}) cannot ${action} ${list.join(' / ')}.`));
    };
}

/** Actor stamp for rows written on behalf of the signed-in user. */
export const actorOf = (req) => ({ id: req.user?.id ?? null, name: req.user?.name ?? 'System' });
