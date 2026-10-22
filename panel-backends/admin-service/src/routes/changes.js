import { Router } from 'express';
import { asyncHandler, validate } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import { listChanges, listAuditEvents } from '../models/auditModel.js';
import { logChange } from '../services/audit.js';

const router = Router();
/** GET /api/v1/changes -- Recent Configuration Changes (newest first). */
router.get('/changes', authenticate, (_req, res) => res.json(listChanges()));

/**
 * POST /api/v1/changes { module, change, oldValue?, newValue? }
 * The portal records each configuration change it makes; who / when /
 * device are stamped by the server.
 */
router.post('/changes', authenticate, asyncHandler(async (req, res) => {
    // Long old/new values (joined lists) are shortened rather than rejected.
    const input = { ...req.body };
    for (const k of ['oldValue', 'newValue']) if (input[k] != null) input[k] = String(input[k]).slice(0, 500);
    const body = validate(input, {
        module: { required: true, max: 60, label: 'Module' },
        change: { required: true, max: 200, label: 'Change' },
        oldValue: { max: 500, label: 'Old value' },
        newValue: { max: 500, label: 'New value' },
    });
    res.status(201).json(logChange(req, body));
}));

/** GET /api/v1/audit-logs -- security / session events (sign-ins, resets, exports). */
router.get('/audit-logs', authenticate, (_req, res) => res.json(listAuditEvents()));

export default router;
