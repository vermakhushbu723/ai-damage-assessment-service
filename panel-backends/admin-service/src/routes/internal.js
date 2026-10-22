import { Router } from 'express';
import { settings } from '../config.js';
import { asyncHandler, badRequest, notFound, HttpError, checkPassword } from '../utils/http.js';
import { hasServiceKey } from '../middleware/authenticate.js';
import { PERMISSION_MODULES } from '../constants.js';
import {
    findUser, findUserRowByLogin, findUserRow, listUsersByRole, recordUserLoginSuccess, recordUserLoginFailure, setUserPassword,
} from '../models/userModel.js';
import { findRole } from '../models/roleModel.js';
import { findRecord, listRecords } from '../models/recordModel.js';
import { findClaim } from '../models/claimModel.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { auditEvent } from '../services/audit.js';

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

/** Why this user cannot use a web portal, or null. */
function portalBlock(user, role) {
    if (user.status !== 'Active') return `This account is ${user.status}. Contact your admin.`;
    if (!role) return 'This account has no role. Contact your admin.';
    if (MOBILE_ONLY_ROLES.includes(user.roleKey)) return `${role.name} accounts use the mobile app, not this portal.`;
    if (user.platform === 'mobile') return 'This account has mobile access only. Ask your admin to enable web access.';
    if (!viewableModules(role).length) return 'Your role has no access to this portal. Contact your admin.';
    return null;
}

/** What a portal needs to know about its signed-in user. */
function portalUser(user) {
    const role = findRole(user.roleKey);
    const branch = user.extra?.branchId ? findRecord('branches', user.extra.branchId) : null;
    return {
        id: user.id,
        userId: user.userId,
        name: user.name,
        email: user.email,
        contact: user.contact,
        employeeId: user.employeeId,
        roleKey: user.roleKey,
        roleName: role?.name ?? user.roleKey,
        roleShort: role?.short ?? null,
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
        blocked: portalBlock(user, role),
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

/** GET /api/v1/internal/users/:id -- re-checked by the portals on every request (they cache it briefly). */
router.get('/users/:id', (req, res) => {
    const user = findUser(req.params.id);
    if (!user) throw notFound('User');
    res.json(portalUser(user));
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
                roleKey: u.roleKey,
                roleName: role.name,
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

export default router;
