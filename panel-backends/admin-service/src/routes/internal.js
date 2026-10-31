import { Router } from 'express';
import { settings } from '../config.js';
import { asyncHandler, badRequest, notFound, HttpError, checkPassword, conflict, normalizePhone, validate } from '../utils/http.js';
import { hasServiceKey } from '../middleware/authenticate.js';
import { PERMISSION_MODULES } from '../constants.js';
import {
    findUser, findUserRowByLogin, findUserRow, listUsersByRole, recordUserLoginSuccess, recordUserLoginFailure, setUserPassword,
    insertUser, setUserStatus,
} from '../models/userModel.js';
import { findRole } from '../models/roleModel.js';
import { findRecord, listRecords } from '../models/recordModel.js';
import { findClaim } from '../models/claimModel.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { auditEvent } from '../services/audit.js';
import { insertAdmin, findAdminRowById, adminEmailTaken, setAdminStatus, setAdminPassword } from '../models/adminModel.js';
import { nextSequentialId } from '../utils/ids.js';
import { db, transaction } from '../db/database.js';

// Server-to-server API for the other panel backends (today: callcenter-service,
// the backend of car-damage-insurance-callcenter). Users are created here in
// Admin > Create Users and sign in on those portals through this API, so a
// suspended account or a changed role takes effect everywhere at once.
//
// Every call needs X-Service-Key = CLAIMS_INGEST_KEY (the same key the claim
// systems use for /claims/ingest). The calling service forwards the browser's
// IP / User-Agent so Audit Logs show the real client.

const router = Router();

router.use((req, _res, next) => {
    if (!settings.claimsIngestKey) return next(new HttpError(503, 'Internal API is disabled: set CLAIMS_INGEST_KEY in admin-service .env.'));
    if (!hasServiceKey(req)) return next(new HttpError(401, 'Invalid service key.'));
    return next();
});

/** Roles that only use the mobile apps -- never a web portal. */
const MOBILE_ONLY_ROLES = ['preinspection-agent', 'preinspection-surveyor', 'internal-surveyor', 'external-surveyor'];
const PORTALS = { callcenter: 'Call Center Portal' };

/** Modules this role may at least view. */
const viewableModules = (role) => PERMISSION_MODULES.filter((m) => role?.permissions?.[m]?.view);

/** Why this role cannot be used on a web portal, or null. */
function roleBlock(roleKey, role) {
    if (!role) return 'This account has no role. Contact your admin.';
    if (MOBILE_ONLY_ROLES.includes(roleKey)) return `${role.name} accounts use the mobile app, not this portal.`;
    if (!viewableModules(role).length) return 'Your role has no access to this portal. Contact your admin.';
    return null;
}

/** Why this user cannot use a web portal at all, or null. */
function accountBlock(user) {
    if (user.status !== 'Active') return `This account is ${user.status}. Contact your admin.`;
    if (user.platform === 'mobile') return 'This account has mobile access only. Ask your admin to enable web access.';
    return null;
}

/**
 * What a portal needs to know about its signed-in user. A user may hold
 * several roles: `roles` lists those usable on a web portal (the portal lets
 * the user switch between them); roleKey / permissions are the active one --
 * `activeRoleKey` when it is one of them, else the primary role, else the
 * first usable role.
 */
function portalUser(user, activeRoleKey) {
    const all = user.roleKeys.map((key) => ({ key, role: findRole(key) }));
    const usable = all.filter(({ key, role }) => !roleBlock(key, role));
    const active = usable.find((r) => r.key === activeRoleKey) ?? usable.find((r) => r.key === user.roleKey) ?? usable[0] ?? all[0];
    const role = active?.role;
    const branch = user.extra?.branchId ? findRecord('branches', user.extra.branchId) : null;
    return {
        id: user.id,
        userId: user.userId,
        name: user.name,
        email: user.email,
        contact: user.contact,
        employeeId: user.employeeId,
        roleKey: active?.key ?? user.roleKey,
        roleName: role?.name ?? user.roleKey,
        roleShort: role?.short ?? null,
        roles: usable.map(({ key, role: r }) => ({ roleKey: key, roleName: r.name, roleShort: r.short ?? null, level: r.level ?? null, permissions: r.permissions ?? {} })),
        organization: user.organization,
        department: user.department ?? null,
        city: user.city ?? null,
        state: user.state ?? null,
        branchId: branch?.id ?? null,
        branch: branch?.name ?? null,
        agentCode: user.extra?.agentCode ?? null,
        status: user.status,
        platform: user.platform,
        mustChangePassword: user.mustChangePassword,
        permissions: role?.permissions ?? {},
        blocked: accountBlock(user) ?? (usable.length ? null : roleBlock(active?.key, role)),
    };
}

const actorOf = (row) => (row ? { id: row.id, name: row.name, role: 'Portal user' } : null);

/**
 * POST /api/v1/internal/portal-login { identifier, password, portal }
 * identifier = User ID or email. Same lockout as every other sign-in
 * (5 wrong passwords -> 15 minutes). -> { user }
 */
router.post('/portal-login', asyncHandler(async (req, res) => {
    const identifier = String(req.body?.identifier ?? '').trim();
    const password = String(req.body?.password ?? '');
    const portal = PORTALS[req.body?.portal] ? req.body.portal : null;
    if (!portal) throw badRequest(`portal must be one of: ${Object.keys(PORTALS).join(', ')}.`);
    if (!identifier || !password) throw badRequest('User ID and password are required.');

    const row = findUserRowByLogin(identifier);
    const module = PORTALS[portal];
    const fail = (detail, status = 401) => {
        auditEvent(req, { update: 'Portal login attempt', reference: 'Failed Login', module, status: 'Failed', detail: `${identifier}: ${detail}`, actor: actorOf(row) ?? { name: identifier } });
        throw new HttpError(status, detail);
    };
    if (!row) fail('Invalid user ID or password.');
    if (row.locked_until && new Date(row.locked_until) > new Date()) {
        const minutes = Math.ceil((new Date(row.locked_until) - Date.now()) / 60_000);
        fail(`Too many failed attempts. Try again in ${minutes} minute${minutes > 1 ? 's' : ''}.`, 423);
    }
    if (!verifyPassword(password, row.password_hash)) {
        const { lockedUntil, failed } = recordUserLoginFailure(row.id, settings.maxFailedLogins, settings.lockMinutes);
        fail(lockedUntil
            ? `Too many failed attempts. Account locked for ${settings.lockMinutes} minutes.`
            : `Invalid user ID or password. ${settings.maxFailedLogins - failed} attempt(s) left.`);
    }
    const user = portalUser(findUser(row.id));
    if (user.blocked) fail(user.blocked, 403);

    recordUserLoginSuccess(row.id);
    auditEvent(req, { update: 'Portal login', reference: 'Login', module, actor: actorOf(row) });
    res.json({ user });
}));

/** POST /api/v1/internal/portal-logout { userId, portal } -- recorded in Audit Logs. */
router.post('/portal-logout', (req, res) => {
    const row = findUserRow(String(req.body?.userId ?? ''));
    if (row) auditEvent(req, { update: 'Portal logout', reference: 'Logout', module: PORTALS[req.body?.portal] ?? 'Portal', actor: actorOf(row) });
    res.json({ ok: true });
});

/**
 * GET /api/v1/internal/users/:id?role=claim-handler -- re-checked by the
 * portals on every request (they cache it briefly); `role` = the role the
 * user picked on the portal.
 */
router.get('/users/:id', (req, res) => {
    const user = findUser(req.params.id);
    if (!user) throw notFound('User');
    res.json(portalUser(user, req.query.role ? String(req.query.role) : undefined));
});

/** POST /api/v1/internal/users/:id/change-password { currentPassword, newPassword } */
router.post('/users/:id/change-password', asyncHandler(async (req, res) => {
    const row = findUserRow(req.params.id);
    if (!row) throw notFound('User');
    const { currentPassword, newPassword } = req.body ?? {};
    if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) throw badRequest('Current password is incorrect.');
    checkPassword(newPassword, 'New password');
    if (newPassword === currentPassword) throw badRequest('New password must be different from the current one.');
    setUserPassword(row.id, hashPassword(newPassword), { mustChange: false });
    auditEvent(req, { update: `Password changed · ${row.user_id}`, reference: 'Password Reset', module: 'Security', actor: actorOf(row) });
    res.json({ ok: true });
}));

/**
 * GET /api/v1/internal/directory?roles=claim-handler,internal-surveyor
 * People the portals assign work to (handlers, surveyors, approvers),
 * with their current claim load. Inactive users are included (status) so a
 * portal can show who is on leave; it decides who can be picked.
 */
router.get('/directory', (req, res) => {
    const roles = String(req.query.roles ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!roles.length) throw badRequest('roles is required.');
    const branches = Object.fromEntries(listRecords('branches').map((b) => [b.id, b]));
    const rows = roles.flatMap((key) => {
        const role = findRole(key);
        if (!role) return [];
        return listUsersByRole(key).map((u) => {
            const branch = branches[u.extra?.branchId];
            return {
                id: u.id,
                userId: u.userId,
                name: u.name,
                employeeId: u.employeeId,
                email: u.email,
                contact: u.contact,
                roleKey: key,
                roleName: role.name,
                primaryRoleKey: u.roleKey,
                accountType: u.accountType ?? null,
                status: u.status,
                department: u.department ?? null,
                city: u.city ?? u.geoCity ?? branch?.city ?? null,
                state: u.state ?? u.geoState ?? branch?.state ?? null,
                pinCode: u.pinCode ?? null,
                zones: u.zones ?? [],
                organization: u.organization,
                branchId: branch?.id ?? null,
                branch: branch?.name ?? null,
                dateOfJoining: u.dateOfJoining ?? null,
                reportingManagerId: u.reportingManagerId ?? null,
                extra: u.extra ?? {},
                handlerStats: u.handlerStats,
            };
        });
    });
    res.json(rows);
});

/** GET /api/v1/internal/claims/:id -- the claim as the Admin portal sees it, plus its fraud triggers. */
router.get('/claims/:id', (req, res) => {
    const claim = findClaim(req.params.id);
    if (!claim) throw notFound('Claim');
    const triggers = listRecords('triggers').filter((t) => t.claim === claim.id);
    res.json({ claim, triggers });
});

// ---------- accounts created by the Super Admin (superadmin-service) ----------

const ACCOUNT_STATUSES = ['Active', 'Inactive', 'Pending', 'Suspended', 'On Leave', 'Resigned'];

/**
 * POST /api/v1/internal/accounts -- a login ID issued in the Super Admin console.
 * { kind: "admin", id, name, email, mobile?, password }         -> Admin portal sign-in (login with id, email or mobile)
 * { kind: "user", id, name, email, mobile?, roleKey, password,  -> Create Users account (call center portal / apps,
 *   status?, organization?, branch?, platform? }                    login with id or email), first login changes the password
 */
router.post('/accounts', asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        kind: { required: true, oneOf: ['admin', 'user'], label: 'kind' },
        id: { required: true, max: 40, label: 'Login ID' },
        name: { required: true, min: 2, max: 100, label: 'Name' },
        email: { required: true, email: true, label: 'Email' },
        mobile: { phone: true, label: 'Mobile number' },
        password: { required: true, label: 'Password' },
        roleKey: { label: 'Role' },
        status: { oneOf: ACCOUNT_STATUSES, label: 'Status' },
        organization: { max: 150, label: 'Organization' },
        branch: { max: 80, label: 'Branch' },
        platform: { oneOf: ['Web', 'Mobile', 'Both'], label: 'Platform' },
    });
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/.test(body.id)) throw badRequest('Login ID is invalid.');
    checkPassword(body.password, 'Password');
    const email = body.email.toLowerCase();
    const mobile = body.mobile ? normalizePhone(body.mobile) : null;
    const loginTaken = db.prepare('SELECT 1 FROM admins WHERE lower(id) = lower(?) UNION SELECT 1 FROM users WHERE lower(user_id) = lower(?) OR lower(employee_id) = lower(?)')
        .get(body.id, body.id, body.id);
    if (loginTaken) throw conflict(`Login ID ${body.id} already exists in the Admin portal.`);

    if (body.kind === 'admin') {
        if (adminEmailTaken(email)) throw conflict(`An Admin portal login with ${email} already exists.`);
        const admin = insertAdmin({ id: body.id, name: body.name, email, mobile, passwordHash: hashPassword(body.password) });
        auditEvent(req, { update: `Admin login ${admin.id} created from the Super Admin console`, reference: 'Created', module: 'Users', actor: { name: 'Super Admin' } });
        return res.status(201).json({ kind: 'admin', id: admin.id, portal: 'Admin Portal' });
    }

    const role = findRole(body.roleKey);
    if (!role) throw badRequest(`Role "${body.roleKey}" does not exist in the Admin portal.`);
    if (db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?)').get(email)) throw conflict(`A user with ${email} already exists in the Admin portal.`);
    const user = transaction(() => insertUser({
        id: nextSequentialId('users', 'USR', 1000),
        userId: body.id,
        employeeId: body.id,
        name: body.name,
        email,
        contact: mobile,
        roleKey: role.key,
        roleKeys: [role.key],
        status: body.status ?? 'Active',
        organization: body.organization ?? null,
        accountType: 'External',
        platform: body.platform ?? 'Both',
        branch: body.branch ?? null,
        createdFrom: 'Super Admin',
        extra: {},
        zones: [],
    }, { passwordHash: hashPassword(body.password), createdBy: 'superadmin' }));
    auditEvent(req, { update: `User ${body.id} (${role.name}) created from the Super Admin console`, reference: 'Created', module: 'Users', actor: { name: 'Super Admin' } });
    res.status(201).json({ kind: 'user', id: body.id, userId: user.id, role: role.name });
}));

/**
 * PATCH /api/v1/internal/accounts/:id { status?, password? } -- User Activation / suspend and
 * password resets done in the Super Admin console.
 */
router.patch('/accounts/:id', (req, res) => {
    const { status, password } = validate(req.body, {
        status: { oneOf: ACCOUNT_STATUSES, label: 'Status' },
        password: { label: 'Password' },
    });
    if (!status && !password) throw badRequest('Send status and/or password.');
    if (password) checkPassword(password, 'Password');
    if (findAdminRowById(req.params.id)) {
        if (status) setAdminStatus(req.params.id, status === 'Active' ? 'Active' : 'Suspended');
        if (password) setAdminPassword(req.params.id, hashPassword(password));
        return res.json({ kind: 'admin', id: req.params.id });
    }
    const row = db.prepare('SELECT id FROM users WHERE lower(user_id) = lower(?)').get(req.params.id);
    if (!row) throw notFound('Account');
    if (status) setUserStatus([row.id], status);
    if (password) setUserPassword(row.id, hashPassword(password), { mustChange: true });
    res.json({ kind: 'user', id: req.params.id });
});

export default router;
