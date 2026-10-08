import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound, conflict } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import { PERMISSION_MODULES, PERMISSION_ACTIONS } from '../constants.js';
import { listRoles, findRole, findRoleByName, insertRole, updateRole, deleteRole } from '../models/roleModel.js';
import { countUsersWithRole } from '../models/userModel.js';
import { viewOnlyPermissions } from '../db/defaults.js';

const router = Router();
router.use(authenticate);

/** Full module x action matrix of booleans; unknown modules/actions rejected. */
function cleanPermissions(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Permissions must be an object.');
    const unknown = Object.keys(input).filter((m) => !PERMISSION_MODULES.includes(m));
    if (unknown.length) throw badRequest(`Unknown module(s): ${unknown.join(', ')}.`);
    return Object.fromEntries(PERMISSION_MODULES.map((m) => {
        const row = input[m] ?? {};
        if (typeof row !== 'object') throw badRequest(`Permissions for ${m} must be an object.`);
        const bad = Object.keys(row).filter((a) => !PERMISSION_ACTIONS.includes(a));
        if (bad.length) throw badRequest(`Unknown action(s) for ${m}: ${bad.join(', ')}.`);
        return [m, Object.fromEntries(PERMISSION_ACTIONS.map((a) => [a, row[a] === true]))];
    }));
}

const shortOf = (name) => name.split(/\s+/).map((w) => w[0]).join('').toUpperCase().slice(0, 4);
const keyOf = (name) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'role'}-${Date.now().toString(36)}`;

/** GET /api/v1/roles -- every role with its permission matrix and user count. */
router.get('/', (_req, res) => res.json(listRoles().map((r) => ({ ...r, users: countUsersWithRole(r.key) }))));

/** POST /api/v1/roles { name, level, copyFrom?, permissions? } -- Create Users > Add Role. */
router.post('/', asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        name: { required: true, max: 40, label: 'Role name' },
        level: { required: true, type: 'number', min: 1, label: 'Role level' },
        copyFrom: { label: 'Copy permissions from' },
        permissions: { type: 'object', label: 'Permissions' },
    });
    if (!Number.isInteger(body.level) || body.level > 5) throw badRequest('Role level must be 1 to 5.');
    if (findRoleByName(body.name)) throw conflict('A role with this name already exists.');
    let permissions = viewOnlyPermissions();
    if (body.permissions) permissions = cleanPermissions(body.permissions);
    else if (body.copyFrom) {
        const source = findRole(body.copyFrom);
        if (!source) throw badRequest('The role to copy from does not exist.');
        permissions = cleanPermissions(source.permissions);
    }
    const role = insertRole({ key: keyOf(body.name), name: body.name, short: shortOf(body.name), level: body.level, extra: null, permissions });
    res.status(201).json({ ...role, users: 0 });
}));

/** PATCH /api/v1/roles/:key { permissions?, name?, level? } -- Roles & Permissions "Save". */
router.patch('/:key', asyncHandler(async (req, res) => {
    const role = findRole(req.params.key);
    if (!role) throw notFound('Role');
    const body = validate(req.body, {
        name: { max: 40, label: 'Role name' },
        level: { type: 'number', min: 1, label: 'Role level' },
        permissions: { type: 'object', label: 'Permissions' },
    }, { partial: true });
    if (body.name) {
        const other = findRoleByName(body.name);
        if (other && other.key !== role.key) throw conflict('A role with this name already exists.');
    }
    if (body.level !== undefined && body.level !== null && (!Number.isInteger(body.level) || body.level > 5)) throw badRequest('Role level must be 1 to 5.');
    const updated = updateRole(role.key, {
        name: body.name || undefined,
        short: body.name ? shortOf(body.name) : undefined,
        level: body.level ?? undefined,
        permissions: body.permissions ? cleanPermissions(body.permissions) : undefined,
    });
    res.json({ ...updated, users: countUsersWithRole(role.key) });
}));

/** DELETE /api/v1/roles/:key -- custom roles nobody holds. */
router.delete('/:key', asyncHandler(async (req, res) => {
    const role = findRole(req.params.key);
    if (!role) throw notFound('Role');
    if (role.isSystem) throw badRequest('Built-in roles cannot be removed.');
    const users = countUsersWithRole(role.key);
    if (users) throw conflict(`${users} user(s) still have this role.`);
    deleteRole(role.key);
    res.json({ ok: true });
}));

export default router;
