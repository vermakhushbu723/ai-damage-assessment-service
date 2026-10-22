import { Router } from 'express';
import { asyncHandler, validate, badRequest } from '../utils/http.js';
import { authenticate, requireMaster } from '../middleware/authenticate.js';
import { RETENTION_OPTIONS } from '../constants.js';
import {
    getSystemSettings, setSystemSettings, insertActivity, listActivity, insertDeployment, listDeployments, purgeOldAuditLogs,
} from '../models/systemModel.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(authenticate);

const snapshot = () => {
    const s = getSystemSettings();
    return { ...s, upToDate: s.currentVersion === s.latestVersion, deployments: listDeployments(), activity: listActivity() };
};

/** GET /api/v1/system -> settings, versions, deployment history, activity table. */
router.get('/', (_req, res) => res.json(snapshot()));

// Switch -> [activity text, activity module]
const LABELS = {
    maintenanceApproval: ['Maintenance approval', 'System Update'],
    autoSecurityPatches: ['Auto security patches', 'System Update'],
    maintenanceMode: ['Maintenance mode', 'System Update'],
    auditLogin: ['Audit login', 'Compliance'],
    inputActivityLogging: ['Input activity logging', 'Compliance'],
    configChangeApproval: ['Config change approval', 'Compliance'],
};

/**
 * PATCH /api/v1/system/settings (master) -- the System Settings switches and Audit Retention.
 * Every change is written to the activity table; with "Config change approval" on,
 * compliance changes are recorded as "Approval Log".
 */
router.patch('/settings', requireMaster, asyncHandler(async (req, res) => {
    const patch = validate(req.body, {
        maintenanceApproval: { type: 'boolean' },
        autoSecurityPatches: { type: 'boolean' },
        maintenanceMode: { type: 'boolean' },
        auditLogin: { type: 'boolean' },
        inputActivityLogging: { type: 'boolean' },
        configChangeApproval: { type: 'boolean' },
        retention: { oneOf: RETENTION_OPTIONS, label: 'Audit retention' },
    }, { partial: true });
    if (!Object.keys(patch).length) throw badRequest('Nothing to update.');
    const before = getSystemSettings();
    setSystemSettings(patch);
    for (const [key, value] of Object.entries(patch)) {
        if (before[key] === value) continue;
        const [text, module] = LABELS[key] ?? ['Audit retention', 'Compliance'];
        const activity = key === 'retention' ? `Change Retention policy to ${value}` : `${text} ${value ? 'ON' : 'OFF'}`;
        const status = module === 'Compliance' && before.configChangeApproval && key !== 'configChangeApproval' ? 'Approval Log' : 'Success';
        insertActivity({ user: req.admin.name, activity, module, status });
    }
    if (patch.retention) purgeOldAuditLogs(patch.retention);
    audit(req, { action: 'Updated', module: 'Settings', detail: `System settings: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}` });
    res.json(snapshot());
}));

/**
 * POST /api/v1/system/update (master) -- "Check/Update". If a newer version is
 * released (LATEST_VERSION) it is recorded as deployed; otherwise reports up to date.
 * With "Maintenance approval required" on, Maintenance Mode must be on first.
 */
router.post('/update', requireMaster, asyncHandler(async (req, res) => {
    const s = getSystemSettings();
    if (s.currentVersion === s.latestVersion) return res.json({ ...snapshot(), message: `Already on the latest version (${s.currentVersion}).` });
    if (s.maintenanceApproval && !s.maintenanceMode) throw badRequest('Update policy requires Maintenance Mode to be ON before updating.');
    setSystemSettings({ currentVersion: s.latestVersion });
    insertDeployment({ version: s.latestVersion, by: req.admin.name });
    insertActivity({ user: req.admin.name, activity: `Updated to ${s.latestVersion}`, module: 'System Update' });
    audit(req, { action: 'Updated', module: 'System', detail: `Platform updated ${s.currentVersion} -> ${s.latestVersion}` });
    return res.json({ ...snapshot(), message: `Updated to ${s.latestVersion}.` });
}));

export default router;
