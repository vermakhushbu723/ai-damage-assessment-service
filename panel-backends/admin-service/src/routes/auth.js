import { Router } from 'express';
import { settings } from '../config.js';
import { signToken } from '../utils/jwt.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { asyncHandler, badRequest, HttpError, checkPassword } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import {
    findAdminRowByIdentifier, findAdminRowById, toAdminDto, recordLoginSuccess, recordLoginFailure, setAdminPassword,
} from '../models/adminModel.js';
import { auditEvent } from '../services/audit.js';

const router = Router();

const sessionPayload = (admin) => ({ admin: { ...admin, organization: settings.organizationName } });

/**
 * POST /api/v1/auth/login  { identifier: email | 10-digit mobile, password }
 * -> { token, expiresIn, admin }. 5 wrong passwords lock the account for 15 minutes.
 */
router.post('/login', asyncHandler(async (req, res) => {
    const identifier = String(req.body?.identifier ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!identifier || !password) throw badRequest('Email/mobile number and password are required.');

    const row = findAdminRowByIdentifier(identifier);
    const fail = (detail, status = 401) => {
        auditEvent(req, { update: 'Login attempt', reference: 'Failed Login', module: 'Security', status: 'Failed', detail: `${identifier}: ${detail}`, actor: row ? toAdminDto(row) : { name: identifier } });
        throw new HttpError(status, detail);
    };

    // Same message for unknown account and wrong password -- don't reveal which logins exist.
    if (!row) fail('Invalid email/mobile number or password.');
    if (row.locked_until && new Date(row.locked_until) > new Date()) {
        const minutes = Math.ceil((new Date(row.locked_until) - Date.now()) / 60_000);
        fail(`Too many failed attempts. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.`, 423);
    }
    if (!verifyPassword(password, row.password_hash)) {
        const { lockedUntil, failed } = recordLoginFailure(row.id, settings.maxFailedLogins, settings.lockMinutes);
        fail(lockedUntil
            ? `Too many failed attempts. Account locked for ${settings.lockMinutes} minutes.`
            : `Invalid email/mobile number or password. ${settings.maxFailedLogins - failed} attempt(s) left.`);
    }
    if (row.status !== 'Active') fail(`This account is ${row.status.toLowerCase()}.`, 403);

    recordLoginSuccess(row.id);
    const admin = toAdminDto(findAdminRowById(row.id));
    const token = signToken({ sub: admin.id }, settings.jwtSecret, settings.jwtExpiresInSeconds);
    auditEvent(req, { update: 'Login', reference: 'Login', module: 'System', actor: admin });
    res.json({ token, expiresIn: settings.jwtExpiresInSeconds, ...sessionPayload(admin) });
}));

/** GET /api/v1/auth/me -> the signed-in admin. */
router.get('/me', authenticate, (req, res) => res.json(sessionPayload(req.admin)));

router.post('/logout', authenticate, (req, res) => {
    auditEvent(req, { update: 'Logout', reference: 'Logout', module: 'System' });
    res.json({ ok: true });
});

/** POST /api/v1/auth/change-password { currentPassword, newPassword } */
router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    const row = findAdminRowById(req.admin.id);
    if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) throw badRequest('Current password is incorrect.');
    checkPassword(newPassword, 'New password');
    if (newPassword === currentPassword) throw badRequest('New password must be different from the current one.');
    setAdminPassword(row.id, hashPassword(newPassword));
    auditEvent(req, { update: 'Own password', reference: 'Password Reset', module: 'Security' });
    res.json({ ok: true });
}));

export default router;
