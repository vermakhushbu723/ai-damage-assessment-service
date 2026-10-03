import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound, conflict } from '../utils/http.js';
import { authenticate, requireMaster } from '../middleware/authenticate.js';
import { listRoles, findRole, insertRole, updateRolePermissions, roleInUse, deleteRole } from '../models/roleModel.js';
import { buildPermissionMatrix, PERMISSION_PAGES, PERMISSION_ACTIONS, MASTER_ROLE } from '../constants.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(authenticate);

/** GET /api/v1/roles -> [{ name, permissions, isSystem }] plus the matrix layout. */
router.get('/', (_req, res) => res.json({ roles: listRoles(), pages: PERMISSION_PAGES, actions: PERMISSION_ACTIONS }));

/** POST /api/v1/roles (master only) -- "+ Create Role" { name, copyFrom? } */
router.post('/', requireMaster, asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        name: { required: true, min: 2, max: 50, label: 'Role name' },
        copyFrom: { label: 'Copy from' },
    });
    if (findRole(body.name)) throw conflict('This role already exists.');
    let permissions = buildPermissionMatrix(false);
    if (body.copyFrom) {
        const source = findRole(body.copyFrom);
        if (!source) throw badRequest(`Role "${body.copyFrom}" does not exist.`);
        permissions = source.permissions;
    }
    const role = insertRole({ name: body.name, permissions });
    audit(req, { action: 'Created', module: 'Users', detail: `Role "${role.name}"${body.copyFrom ? ` (copied from ${body.copyFrom})` : ''}` });
    res.status(201).json(role);
}));

/** PUT /api/v1/roles/:name/permissions (master only) -- "Save / Update" { permissions: { page: { view, edit, ... } } } */
router.put('/:name/permissions', requireMaster, asyncHandler(async (req, res) => {
    const role = findRole(req.params.name);
    if (!role) throw notFound('Role');
    const permissions = req.body?.permissions;
    if (!permissions || typeof permissions !== 'object') throw badRequest('permissions must be an object.');
    if (role.name === MASTER_ROLE) {
        const off = PERMISSION_PAGES.find((p) => !permissions[p]?.view);
        if (off) throw badRequest(`Super Admin must keep View access (missing on "${off}").`);
    }
    const updated = updateRolePermissions(role.name, permissions);
    audit(req, { action: 'Updated', module: 'Users', detail: `Permissions of role "${role.name}"` });
    res.json(updated);
}));

/** DELETE /api/v1/roles/:name (master only) -- custom roles nobody uses. */
router.delete('/:name', requireMaster, asyncHandler(async (req, res) => {
    const role = findRole(req.params.name);
    if (!role) throw notFound('Role');
    if (role.isSystem) throw badRequest('System roles cannot be deleted.');
    const inUse = roleInUse(role.name);
    if (inUse) throw badRequest(`${inUse} admin user(s) still have this role.`);
    deleteRole(role.name);
    audit(req, { action: 'Deleted', module: 'Users', detail: `Role "${role.name}"` });
    res.json({ ok: true });
}));

export default router;
