import { Router } from 'express';
import { asyncHandler, badRequest } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import { insertRecord } from '../models/recordModel.js';
import { getSetting } from '../models/settingsModel.js';
import { nextSequentialId } from '../utils/ids.js';
import { systemInfo, newer } from './settings.js';

const router = Router();
router.use(authenticate);

/** GET /api/v1/system -- versions + deployment history (also part of GET /settings systemUpdate). */
router.get('/', (_req, res) => res.json(systemInfo()));

/**
 * POST /api/v1/system/update -- System Update "Update Now": records the move
 * to the latest released version (LATEST_VERSION in .env). Refused while
 * maintenance approval is required.
 */
router.post('/update', asyncHandler(async (req, res) => {
    const info = systemInfo();
    if (!newer(info.latest, info.current)) throw badRequest(`v${info.current} is already the latest version.`);
    if (getSetting('systemUpdate').maintenanceApproval) throw badRequest('Maintenance approval is required — request approval first.');
    insertRecord('deployments', {
        id: nextSequentialId('records', 'DP', 1000, 'deployments'),
        version: info.latest,
        at: new Date().toISOString(),
        by: req.admin.name,
        notes: req.body?.notes ? String(req.body.notes).slice(0, 200) : 'Platform update',
    });
    res.json(systemInfo());
}));

export default router;
