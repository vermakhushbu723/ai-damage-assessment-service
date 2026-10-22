import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound, conflict, checkPassword, normalizePhone } from '../utils/http.js';
import { authenticate, requireMaster } from '../middleware/authenticate.js';
import { ADMIN_STATUSES, ADMIN_SCOPES, MASTER_ROLE } from '../constants.js';
import {
    listAdmins, findAdminById, insertAdmin, updateAdmin, emailTaken, countActiveMasters,
} from '../models/adminUserModel.js';
import { findRole } from '../models/roleModel.js';
import { hashPassword } from '../utils/password.js';
import { generatePassword, nextSequentialId } from '../utils/ids.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(authenticate);

/** GET /api/v1/admin-users -- every console login (any admin can view). */
router.get('/', (_req, res) => res.json(listAdmins()));

/**
 * POST /api/v1/admin-users (master only) -- "+ Add Admin User".
 * { name, email, phone?, role, scope?, status?, mfa?, password? } -> { admin, credentials }
 */
router.post('/', requireMaster, asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        name: { required: true, min: 2, max: 100, label: 'Full name' },
        email: { required: true, email: true, label: 'Email' },
        phone: { phone: true, label: 'Mobile number' },
        role: { required: true, label: 'Role' },
        scope: { oneOf: ADMIN_SCOPES, label: 'Scope' },
        status: { oneOf: ADMIN_STATUSES, label: 'Status' },
        mfa: { type: 'boolean', label: 'MFA' },
        password: { label: 'Temporary password' },
    });
    if (!findRole(body.role)) throw badRequest(`Role "${body.role}" does not exist.`);
    if (emailTaken(body.email)) throw conflict('An admin with this email already exists.');
    const password = body.password || generatePassword();
    checkPassword(password, 'Temporary password');

    const admin = insertAdmin({
        id: nextSequentialId('admin_users', 'ADM', 100),
        name: body.name,
        email: body.email.toLowerCase(),
        phone: body.phone ? normalizePhone(body.phone) : null,
        role: body.role,
        scope: body.scope ?? 'all',
        status: body.status ?? 'Active',
        mfa: body.mfa ?? false,
        passwordHash: hashPassword(password),
    });
    audit(req, { action: 'Created', module: 'Users', detail: `Admin ${admin.id} ${admin.email} (${admin.role})` });
    res.status(201).json({ admin, credentials: { loginId: admin.email, password } });
}));

/** PATCH /api/v1/admin-users/:id (master only) -- inline Role / Status / MFA edits. */
router.patch('/:id', requireMaster, asyncHandler(async (req, res) => {
    const target = findAdminById(req.params.id);
    if (!target) throw notFound('Admin user');
    const patch = validate(req.body, {
        name: { min: 2, max: 100, label: 'Full name' },
        email: { email: true, label: 'Email' },
        phone: { phone: true, label: 'Mobile number' },
        role: { label: 'Role' },
        scope: { oneOf: ADMIN_SCOPES, label: 'Scope' },
        status: { oneOf: ADMIN_STATUSES, label: 'Status' },
        mfa: { type: 'boolean', label: 'MFA' },
    }, { partial: true });
    if (patch.role && !findRole(patch.role)) throw badRequest(`Role "${patch.role}" does not exist.`);
    if (patch.email && emailTaken(patch.email, target.id)) throw conflict('An admin with this email already exists.');
    if (patch.phone) patch.phone = normalizePhone(patch.phone);

    // Never leave the console without an active master Super Admin.
    const losesMaster = target.role === MASTER_ROLE && target.scope === 'all' && target.status === 'Active'
        && ((patch.role && patch.role !== MASTER_ROLE) || (patch.scope && patch.scope !== 'all') || (patch.status && patch.status !== 'Active'));
    if (losesMaster && countActiveMasters() <= 1) throw badRequest('This is the last active master Super Admin and cannot be demoted or suspended.');
    if (target.id === req.admin.id && patch.status && patch.status !== 'Active') throw badRequest('You cannot suspend your own account.');

    const updated = updateAdmin(target.id, patch);
    audit(req, { action: 'Updated', module: 'Users', detail: `Admin ${target.id}: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}` });
    res.json(updated);
}));

/** POST /api/v1/admin-users/:id/reset-password (master only) -> new temporary password. */
router.post('/:id/reset-password', requireMaster, asyncHandler(async (req, res) => {
    const target = findAdminById(req.params.id);
    if (!target) throw notFound('Admin user');
    const password = req.body?.password || generatePassword();
    checkPassword(password, 'Password');
    updateAdmin(target.id, { passwordHash: hashPassword(password) });
    audit(req, { action: 'Updated', module: 'Users', detail: `Password reset for admin ${target.id}` });
    res.json({ loginId: target.email, password });
}));

export default router;
