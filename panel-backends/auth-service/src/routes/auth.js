import { Router } from 'express';
import { isValidRole, ROLE_VALUES } from '../schemas/roles.js';
import { findUserByRoleAndUsername, findUserById, touchLastLogin, toPublicUser } from '../models/userModel.js';
import { verifyPassword } from '../utils/password.js';
import { signToken } from '../utils/jwt.js';
import { settings } from '../config.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

// POST /api/v1/auth/login
// body: { role: 'claim_workshop'|'claim_surveyor'|'preinspection_agent'|'preinspection_surveyor', username, password }
// -> { token, user: { id, role, username, name, ... } }
//
// `role` is required and checked first -- the same username can exist
// under different portals as unrelated accounts (see db/database.js's
// UNIQUE(role, username) index), so login always needs both to know which
// account is meant.
router.post('/api/v1/auth/login', (req, res) => {
    const { role, username, password } = req.body || {};

    if (!role || !isValidRole(role)) {
        return res.status(400).json({ detail: `"role" must be one of: ${ROLE_VALUES.join(', ')}` });
    }
    if (!username || typeof username !== 'string') {
        return res.status(400).json({ detail: '"username" is required.' });
    }
    if (!password || typeof password !== 'string') {
        return res.status(400).json({ detail: '"password" is required.' });
    }

    const user = findUserByRoleAndUsername(role, username.trim());
    // Same generic message whether the username doesn't exist for this role
    // or the password is wrong -- don't leak which one it was.
    if (!user || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ detail: 'Invalid username or password.' });
    }

    touchLastLogin(user.id);

    const token = signToken(
        { sub: user.id, role: user.role, username: user.username, name: user.name },
        settings.jwtSecret,
        settings.jwtExpiresInSeconds
    );

    return res.json({
        token,
        expiresInSeconds: settings.jwtExpiresInSeconds,
        user: toPublicUser(user),
    });
});

// GET /api/v1/auth/me -- Authorization: Bearer <token>
// Re-fetches the user fresh from the DB (not just the token's claims) so a
// deactivated account is rejected immediately rather than staying "logged
// in" until the token naturally expires.
router.get('/api/v1/auth/me', authenticate, (req, res) => {
    const user = findUserById(req.auth.sub);
    if (!user) {
        return res.status(401).json({ detail: 'Account no longer exists or is inactive.' });
    }
    return res.json({ user: toPublicUser(user) });
});

// POST /api/v1/auth/logout -- tokens are stateless (no server-side session),
// so there's nothing to invalidate server-side; this exists purely so the
// frontend has one consistent endpoint to call instead of just discarding
// the token client-side. Always succeeds.
router.post('/api/v1/auth/logout', (_req, res) => {
    res.json({ ok: true });
});

export default router;
