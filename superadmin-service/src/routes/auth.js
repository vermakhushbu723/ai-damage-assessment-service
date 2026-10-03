import { Router } from 'express';
import { settings } from '../config.js';
import { signToken } from '../utils/jwt.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { asyncHandler, badRequest, HttpError, checkPassword } from '../utils/http.js';
import { authenticate, isMaster } from '../middleware/authenticate.js';
import {
    findAdminRowByIdentifier, findAdminRowById, toAdminDto, recordLoginSuccess, recordLoginFailure, updateAdmin,
} from '../models/adminUserModel.js';
import { findRole } from '../models/roleModel.js';
import { audit } from '../services/audit.js';

const router = Router();

const sessionPayload = (admin) => ({
    admin: { ...admin, isMaster: isMaster(admin) },
    permissions: findRole(admin.role)?.permissions ?? {},
});

/**
 * POST /api/v1/auth/login  { identifier: email | 10-digit mobile, password }
 * -> { token, expiresIn, admin, permissions }
 * 5 wrong passwords lock the account for 15 minutes.
 */
router.post('/login', asyncHandler(async (req, res) => {
    const identifier = String(req.body?.identifier ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!identifier || !password) throw badRequest('Email/mobile number and password are required.');

    const row = findAdminRowByIdentifier(identifier);
    const fail = (detail, status = 401) => {
        audit(req, { action: 'Login', module: 'System', status: 'Failed', detail: `${identifier}: ${detail}`, actor: row ? toAdminDto(row) : { name: identifier } });
        throw new HttpError(status, detail);
    };

    // Same message for unknown account and wrong password -- don't reveal which emails exist.
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
    if (row.status !== 'Active') fail(`This account is ${row.status.toLowerCase()}. Contact the master Super Admin.`, 403);

    recordLoginSuccess(row.id);
    const admin = toAdminDto(findAdminRowById(row.id));
    const token = signToken({ sub: admin.id, role: admin.role, scope: admin.scope }, settings.jwtSecret, settings.jwtExpiresInSeconds);
    audit(req, { action: 'Login', module: 'System', actor: admin });
    res.json({ token, expiresIn: settings.jwtExpiresInSeconds, ...sessionPayload(admin) });
}));

/** GET /api/v1/auth/me -> current admin + their role's permission matrix. */
router.get('/me', authenticate, (req, res) => res.json(sessionPayload(req.admin)));

router.post('/logout', authenticate, (req, res) => {
    audit(req, { action: 'Logout', module: 'System' });
    res.json({ ok: true });
});

/** POST /api/v1/auth/change-password { currentPassword, newPassword } */
router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    const row = findAdminRowById(req.admin.id);
    if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) throw badRequest('Current password is incorrect.');
    checkPassword(newPassword, 'New password');
    if (newPassword === currentPassword) throw badRequest('New password must be different from the current one.');
    updateAdmin(row.id, { passwordHash: hashPassword(newPassword) });
    audit(req, { action: 'Updated', module: 'Users', detail: 'Changed own password' });
    res.json({ ok: true });
}));

export default router;
