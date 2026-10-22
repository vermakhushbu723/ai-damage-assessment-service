import { Router } from 'express';
import { settings } from '../config.js';
import { asyncHandler, validate, badRequest, notFound, checkPassword, normalizePhone } from '../utils/http.js';
import { authenticate, serviceModelOfAdmin } from '../middleware/authenticate.js';
import { USER_ROLES, USER_STATUSES, PLATFORMS } from '../constants.js';
import { transaction } from '../db/database.js';
import {
    listUsers, findUser, insertUser, updateUser, setUserPassword, insertResetToken,
} from '../models/userModel.js';
import { findOrganization } from '../models/organizationModel.js';
import { hashPassword } from '../utils/password.js';
import { generatePassword, nextSequentialId, randomToken, sha256 } from '../utils/ids.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(authenticate);

/** 404 for users of organizations outside this admin's scope. */
function loadOwnUser(req, id = req.params.id) {
    const user = findUser(id);
    const own = serviceModelOfAdmin(req.admin);
    if (!user || (own && user.serviceModel !== own)) throw notFound('User');
    return user;
}

function loadOwnOrganization(req, organizationId) {
    const org = findOrganization(organizationId);
    const own = serviceModelOfAdmin(req.admin);
    if (!org || (own && org.serviceModel !== own)) throw badRequest('Selected organization does not exist.');
    return org;
}

/** GET /api/v1/users -> users of the organizations this admin manages. */
router.get('/', (req, res) => res.json(listUsers(serviceModelOfAdmin(req.admin))));

/**
 * POST /api/v1/users/verify { userId, email, phone } -- Password Reset "Verify User".
 * All three must match the registered details.
 */
router.post('/verify', asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        userId: { required: true, label: 'User ID' },
        email: { required: true, email: true, label: 'Registered email' },
        phone: { required: true, phone: true, label: 'Registered contact number' },
    });
    let user;
    try {
        user = loadOwnUser(req, body.userId);
    } catch {
        audit(req, { action: 'Verified', module: 'Users', status: 'Failed', detail: `Password reset lookup: no user ${body.userId}` });
        throw notFound(`User "${body.userId}"`);
    }
    const mismatched = [
        user.email.toLowerCase() !== body.email.toLowerCase() && 'email',
        normalizePhone(user.phone) !== normalizePhone(body.phone) && 'contact number',
    ].filter(Boolean);
    if (mismatched.length) {
        audit(req, { action: 'Verified', module: 'Users', status: 'Failed', detail: `Password reset for ${user.id}: ${mismatched.join(' & ')} mismatch` });
        throw badRequest(`Registered contact details do not match (${mismatched.join(' & ')}).`);
    }
    audit(req, { action: 'Verified', module: 'Users', detail: `Password reset: verified ${user.id}` });
    res.json(user);
}));

/** POST /api/v1/users/bulk-status { ids: [...], status } -- User Activation bulk action. */
router.post('/bulk-status', asyncHandler(async (req, res) => {
    const { status } = validate(req.body, { status: { required: true, oneOf: USER_STATUSES, label: 'Status' } });
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))] : [];
    if (!ids.length) throw badRequest('Select at least one user.');
    const users = ids.map((id) => loadOwnUser(req, id));
    const updated = transaction(() => users.map((u) => updateUser(u.id, { status })));
    audit(req, { action: 'Updated', module: 'Users', detail: `Status ${status} for ${ids.join(', ')}` });
    res.json(updated);
}));

router.get('/:id', (req, res) => res.json(loadOwnUser(req)));

/**
 * POST /api/v1/users -- "+ Add User".
 * { organizationId, name, email, phone, role, branch?, platform?, status?, password? } -> { user, credentials }
 */
router.post('/', asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        organizationId: { required: true, label: 'Organization' },
        name: { required: true, min: 2, max: 100, label: 'Full name' },
        email: { required: true, email: true, label: 'Email' },
        phone: { required: true, phone: true, label: 'Mobile number' },
        role: { required: true, oneOf: USER_ROLES, label: 'Role' },
        branch: { max: 80, label: 'Branch' },
        platform: { oneOf: PLATFORMS, label: 'Platform' },
        status: { oneOf: USER_STATUSES, label: 'Status' },
        password: { label: 'Password' },
    });
    const org = loadOwnOrganization(req, body.organizationId);
    const password = body.password || generatePassword();
    checkPassword(password);
    const user = insertUser({
        id: nextSequentialId('users', 'USR', 1000),
        organizationId: org.id,
        name: body.name,
        email: body.email.toLowerCase(),
        phone: normalizePhone(body.phone),
        role: body.role,
        branch: body.branch ?? null,
        platform: body.platform ?? 'Both',
        status: body.status ?? 'Active',
        passwordHash: hashPassword(password),
        mustChangePassword: true,
    });
    audit(req, { action: 'Created', module: 'Users', detail: `${user.id} ${user.name} (${org.name})` });
    res.status(201).json({ user, credentials: { loginId: user.id, password } });
}));

/** PATCH /api/v1/users/:id -- inline Role / Status edits, User Activation. */
router.patch('/:id', asyncHandler(async (req, res) => {
    const user = loadOwnUser(req);
    const patch = validate(req.body, {
        name: { min: 2, max: 100, label: 'Full name' },
        email: { email: true, label: 'Email' },
        phone: { phone: true, label: 'Mobile number' },
        role: { oneOf: USER_ROLES, label: 'Role' },
        branch: { max: 80, label: 'Branch' },
        platform: { oneOf: PLATFORMS, label: 'Platform' },
        status: { oneOf: USER_STATUSES, label: 'Status' },
        organizationId: { label: 'Organization' },
    }, { partial: true });
    if (patch.organizationId) loadOwnOrganization(req, patch.organizationId);
    if (patch.phone) patch.phone = normalizePhone(patch.phone);
    if (patch.email) patch.email = patch.email.toLowerCase();
    const updated = updateUser(user.id, patch);
    audit(req, { action: 'Updated', module: 'Users', detail: `${user.id}: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}` });
    res.json(updated);
}));

/**
 * POST /api/v1/users/:id/reset-link -- "Send Link".
 * Creates a one-time link (valid RESET_LINK_TTL_HOURS). No mail server is
 * configured for this service, so the link is returned for the admin to share.
 */
router.post('/:id/reset-link', asyncHandler(async (req, res) => {
    const user = loadOwnUser(req);
    if (user.status === 'Suspended') throw badRequest('This user is suspended. Activate the user before resetting the password.');
    const token = randomToken();
    const expiresAt = new Date(Date.now() + settings.resetLinkTtlHours * 3600_000).toISOString();
    insertResetToken({ tokenHash: sha256(token), userId: user.id, expiresAt, createdBy: req.admin.id });
    audit(req, { action: 'Updated', module: 'Users', detail: `Reset link generated for ${user.id}` });
    res.json({ link: `${settings.resetLinkBase}?token=${token}`, expiresAt, email: user.email, emailSent: false });
}));

/** POST /api/v1/users/:id/reset-password { password, reason } -- "Reset Manually". */
router.post('/:id/reset-password', asyncHandler(async (req, res) => {
    const user = loadOwnUser(req);
    const { password, reason } = validate(req.body, {
        password: { required: true, label: 'New password' },
        reason: { required: true, min: 3, max: 300, label: 'Reason' },
    });
    checkPassword(password, 'New password');
    setUserPassword(user.id, hashPassword(password), true);
    audit(req, { action: 'Updated', module: 'Users', detail: `Manual password reset for ${user.id}. Reason: ${reason}` });
    res.json({ ok: true, userId: user.id, mustChangePassword: true });
}));

export default router;
