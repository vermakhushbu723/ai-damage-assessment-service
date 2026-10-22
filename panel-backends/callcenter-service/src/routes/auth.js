import { Router } from 'express';
import { settings } from '../config.js';
import { signToken } from '../utils/jwt.js';
import { asyncHandler, badRequest } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import { portalLogin, portalLogout, changePassword, forgetUser } from '../services/adminClient.js';
import { MODULES } from '../constants.js';

// Sign-in with the account created in Admin > Create Users. admin-service
// checks the password, lockout, status, web access and role; this service
// then issues its own session token (kind: 'callcenter').

const router = Router();

/** What the portal keeps about its user: who, and what the role may do here. */
const sessionUser = (u) => ({
    id: u.id,
    userId: u.userId,
    name: u.name,
    email: u.email,
    contact: u.contact,
    employeeId: u.employeeId,
    roleKey: u.roleKey,
    roleName: u.roleName,
    organization: u.organization,
    branch: u.branch,
    agentCode: u.agentCode,
    mustChangePassword: !!u.mustChangePassword,
    permissions: Object.fromEntries(Object.values(MODULES).map((m) => [m, u.permissions?.[m] ?? {}])),
});

/** POST /api/v1/auth/login { identifier (User ID or email), password } -> { token, expiresIn, user } */
router.post('/login', asyncHandler(async (req, res) => {
    const identifier = String(req.body?.identifier ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!identifier || !password) throw badRequest('Enter your User ID and password.');
    const { user } = await portalLogin(identifier, password, req);
    forgetUser(user.id);
    const token = signToken({ sub: user.id, kind: 'callcenter' }, settings.jwtSecret, settings.jwtExpiresInSeconds);
    res.json({ token, expiresIn: settings.jwtExpiresInSeconds, user: sessionUser(user) });
}));

router.get('/me', authenticate, (req, res) => res.json({ user: sessionUser(req.user) }));

router.post('/logout', authenticate, asyncHandler(async (req, res) => {
    await portalLogout(req.user.id, req);
    forgetUser(req.user.id);
    res.json({ ok: true });
}));

/** POST /api/v1/auth/change-password { currentPassword, newPassword } -- first sign-in with a temp password. */
router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (!currentPassword || !newPassword) throw badRequest('Enter the current and the new password.');
    await changePassword(req.user.id, String(currentPassword), String(newPassword), req);
    forgetUser(req.user.id);
    res.json({ ok: true });
}));

export default router;
