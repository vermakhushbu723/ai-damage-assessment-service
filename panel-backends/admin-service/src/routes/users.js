import { Router } from 'express';
import { settings } from '../config.js';
import { asyncHandler, validate, badRequest, notFound, conflict, checkPassword, normalizePhone } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import {
    ACCOUNT_TYPES, ACCOUNT_STATUSES, BLOCKED_STATUSES, DEPARTMENTS, ZONES, COUNTRIES, PLATFORMS, STATES, DEFAULT_CAPACITY,
} from '../constants.js';
import {
    listUsers, findUser, findUserRow, findUserByLogin, findDuplicate, findByAgentCode, insertUser, updateUser, setUserStatus,
    setUserPassword, insertResetToken,
} from '../models/userModel.js';
import { findRole } from '../models/roleModel.js';
import { findRecord } from '../models/recordModel.js';
import { hashPassword } from '../utils/password.js';
import { generatePassword, nextSequentialId, randomToken, sha256 } from '../utils/ids.js';
import { auditEvent } from '../services/audit.js';
import { transaction } from '../db/database.js';

const router = Router();
router.use(authenticate);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,59}$/;
const USER_ID_RE = /^[a-zA-Z0-9._-]{4,30}$/;
const MAX_IMAGE_CHARS = 1.5 * 1024 * 1024; // 1 MB file as a data URL

// Every field of the Create Users form. Presence of the core fields is
// required by the API; the rest is checked when sent.
const SPEC = {
    accountType: { required: true, oneOf: ACCOUNT_TYPES, label: 'Account type' },
    roleKey: { required: true, label: 'Role' },
    reportingManagerId: { label: 'Reporting manager' },
    name: { required: true, max: 60, label: 'Full name' },
    employeeId: { required: true, max: 40, label: 'Employee ID' },
    email: { required: true, email: true, max: 120, label: 'Official email' },
    contact: { required: true, phone: true, label: 'Contact number' },
    altContact: { phone: true, label: 'Alternate contact number' },
    department: { oneOf: DEPARTMENTS, label: 'Department' },
    dateOfJoining: { label: 'Date of joining' },
    city: { max: 60, label: 'City' },
    state: { oneOf: STATES, label: 'State' },
    region: { max: 60, label: 'Region' },
    country: { oneOf: COUNTRIES, label: 'Country' },
    pinCode: { label: 'Pin code' },
    profileImage: { max: MAX_IMAGE_CHARS, label: 'Profile image' },
    zones: { type: 'array', label: 'Zone' },
    geoRegion: { oneOf: STATES, label: 'Geography region' },
    geoCity: { max: 60, label: 'Geography city' },
    geoState: { oneOf: STATES, label: 'Geography state' },
    platform: { required: true, oneOf: PLATFORMS, label: 'Platform access' },
    status: { required: true, oneOf: ACCOUNT_STATUSES, label: 'Account status' },
    effectiveFrom: { label: 'Effective from date' },
    userId: { required: true, label: 'User ID' },
    extra: { type: 'object', label: 'Role-specific fields' },
    capacityLimit: { type: 'number', min: 1, label: 'Capacity limit' },
};

/** Field checks the generic spec can't express. Returns the cleaned body. */
function checkUser(body, existingId = '') {
    if (body.name !== undefined && !NAME_RE.test(body.name)) throw badRequest('Full name: letters and spaces only.');
    if (body.userId !== undefined && !USER_ID_RE.test(body.userId)) throw badRequest('User ID must be 4-30 letters, numbers, . _ -');
    if (body.pinCode && !/^\d{6}$/.test(body.pinCode)) throw badRequest('Pin code must be 6 digits.');
    for (const k of ['dateOfJoining', 'effectiveFrom']) if (body[k] && !DATE_RE.test(body[k])) throw badRequest(`${k} must be YYYY-MM-DD.`);
    if (body.zones && body.zones.some((z) => !ZONES.includes(z))) throw badRequest(`Zone must be one of: ${ZONES.join(', ')}.`);
    if (body.profileImage && !/^data:image\/(png|jpeg);base64,/.test(body.profileImage)) throw badRequest('Profile image must be a JPG or PNG.');
    if (body.contact) body.contact = normalizePhone(body.contact);
    if (body.altContact) {
        body.altContact = normalizePhone(body.altContact);
        if (body.contact && body.altContact === body.contact) throw badRequest('Alternate contact number must differ from the contact number.');
    }
    if (body.roleKey !== undefined && !findRole(body.roleKey)) throw badRequest('Selected role does not exist.');
    if (body.reportingManagerId && body.reportingManagerId !== 'ADMIN') {
        if (body.reportingManagerId === existingId) throw badRequest('A user cannot report to themselves.');
        if (!findUserRow(body.reportingManagerId)) throw badRequest('Selected reporting manager does not exist.');
    }
    if (body.extra?.branchId && !findRecord('branches', body.extra.branchId)) throw badRequest('Assigned branch does not exist.');
    for (const [field, label] of [['userId', 'User ID'], ['email', 'Email'], ['employeeId', 'Employee ID']]) {
        if (body[field] && findDuplicate(field, body[field], existingId)) throw conflict(`${label} already exists.`);
    }
    if (body.extra?.agentCode) {
        if (!/^CC-\d{4}$/.test(body.extra.agentCode)) throw badRequest('Agent code format: CC-XXXX.');
        if (findByAgentCode(body.extra.agentCode, existingId)) throw conflict('Agent code already used.');
    }
    return body;
}

/** Branch organization > portal's insurer for Internal users > what was sent. */
function organizationFor(body, current) {
    const branch = body.extra?.branchId && findRecord('branches', body.extra.branchId);
    if (branch) return branch.organization;
    if ((body.accountType ?? current?.accountType) === 'Internal') return settings.organizationName;
    return current?.organization && current.organization !== settings.organizationName ? current.organization : 'External Partner';
}

/** GET /api/v1/users */
router.get('/', (_req, res) => res.json(listUsers()));

/** GET /api/v1/users/:id */
router.get('/:id', (req, res) => {
    const user = findUser(req.params.id, { withImage: true });
    if (!user) throw notFound('User');
    res.json(user);
});

/**
 * POST /api/v1/users -- Create Users. Optional `tempPassword` (the one shown
 * on the form); otherwise one is generated. Returns the user plus
 * `tempPassword` once -- only its hash is stored.
 */
router.post('/', asyncHandler(async (req, res) => {
    const body = checkUser(validate(req.body, SPEC));
    let tempPassword = typeof req.body?.tempPassword === 'string' && req.body.tempPassword ? req.body.tempPassword : null;
    if (tempPassword) checkPassword(tempPassword, 'Temp password');
    else tempPassword = generatePassword();
    const { capacityLimit, ...rest } = body;
    const user = transaction(() => insertUser({
        ...rest,
        id: nextSequentialId('users', 'USR', 1000),
        organization: organizationFor(body),
        extra: body.extra ?? {},
        zones: body.zones ?? [],
        ...(body.roleKey === 'claim-handler' ? { capacityLimit: capacityLimit ?? DEFAULT_CAPACITY } : {}),
    }, { passwordHash: hashPassword(tempPassword), createdBy: req.admin.id }));
    res.status(201).json({ ...user, tempPassword });
}));

/**
 * PATCH /api/v1/users/:id -- Modify user, inline status, capacity limit
 * (`capacityLimit` or `handlerStats.capacityLimit`). Passwords never change here.
 */
router.patch('/:id', asyncHandler(async (req, res) => {
    const current = findUser(req.params.id);
    if (!current) throw notFound('User');
    const input = { ...req.body };
    if (input.handlerStats?.capacityLimit !== undefined && input.capacityLimit === undefined) input.capacityLimit = input.handlerStats.capacityLimit;
    const body = checkUser(validate(input, SPEC, { partial: true }), current.id);
    for (const k of ['accountType', 'roleKey', 'name', 'employeeId', 'email', 'contact', 'platform', 'status', 'userId']) {
        if (k in body && body[k] === null) throw badRequest(`${SPEC[k].label} is required.`);
    }
    if ('accountType' in body || 'extra' in body) body.organization = organizationFor({ ...current, ...body }, current);
    const updated = updateUser(current.id, body);
    res.json(updated);
}));

/** POST /api/v1/users/bulk-status { ids, status } -- User Activation. */
router.post('/bulk-status', asyncHandler(async (req, res) => {
    const { ids, status } = validate(req.body, {
        ids: { required: true, type: 'array', label: 'Users' },
        status: { required: true, oneOf: ACCOUNT_STATUSES, label: 'Status' },
    });
    if (!ids.length || ids.some((id) => typeof id !== 'string')) throw badRequest('Select at least one user.');
    const missing = ids.filter((id) => !findUserRow(id));
    if (missing.length) throw badRequest(`Unknown user(s): ${missing.join(', ')}.`);
    const changed = transaction(() => setUserStatus(ids, status));
    res.json({ updated: changed, users: ids.map(findUser) });
}));

/** POST /api/v1/users/verify { userId, email, contact } -- Password Reset: Verify User. */
router.post('/verify', asyncHandler(async (req, res) => {
    const { userId, email, contact } = req.body ?? {};
    if (!String(userId ?? '').trim()) throw badRequest('Enter the User ID.');
    const user = findUserByLogin(userId);
    if (!user) throw notFound(`User with User ID "${String(userId).trim()}"`);
    if (!String(email ?? '').trim() || !String(contact ?? '').trim()) throw badRequest('Enter the registered email address and contact number.');
    if (user.email.toLowerCase() !== String(email).trim().toLowerCase()) throw badRequest('Email address does not match the registered email.');
    if (normalizePhone(user.contact) !== normalizePhone(contact)) throw badRequest('Contact number does not match the registered number.');
    if (BLOCKED_STATUSES.includes(user.status)) throw badRequest(`${user.name}'s account is ${user.status}. Activate it in User Activation first.`);
    res.json(user);
}));

function resettableUser(id) {
    const user = findUser(id);
    if (!user) throw notFound('User');
    if (BLOCKED_STATUSES.includes(user.status)) throw badRequest(`${user.name}'s account is ${user.status}. Activate it in User Activation first.`);
    return user;
}

/**
 * POST /api/v1/users/:id/reset-link -- Send Link. No mail server is
 * configured, so the one-time link is returned for the admin to share
 * (`emailSent: false`).
 */
router.post('/:id/reset-link', asyncHandler(async (req, res) => {
    const user = resettableUser(req.params.id);
    const token = randomToken();
    const expiresAt = new Date(Date.now() + settings.resetLinkTtlHours * 3600_000).toISOString();
    insertResetToken({ tokenHash: sha256(token), userId: user.id, expiresAt, createdBy: req.admin.id });
    auditEvent(req, { update: `Reset link · ${user.userId}`, reference: 'Password Reset', module: 'Security', detail: `Link for ${user.email}` });
    res.json({ link: `${settings.resetLinkBase}?token=${encodeURIComponent(token)}`, expiresAt, email: user.email, emailSent: false, user: findUser(user.id) });
}));

/** POST /api/v1/users/:id/reset-password -- Reset Manually: issues a new temp password (returned once). */
router.post('/:id/reset-password', asyncHandler(async (req, res) => {
    const user = resettableUser(req.params.id);
    const tempPassword = generatePassword();
    setUserPassword(user.id, hashPassword(tempPassword), { mustChange: true });
    auditEvent(req, { update: `Manual reset · ${user.userId}`, reference: 'Password Reset', module: 'Security' });
    res.json({ tempPassword, user: findUser(user.id) });
}));

export default router;
