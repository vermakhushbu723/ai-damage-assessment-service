import { Router } from 'express';
import { asyncHandler, validate } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import { listAuditLogs } from '../models/auditModel.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(authenticate);

/** GET /api/v1/audit-logs?from&to&user&role&module&action&status&limit -> newest first. */
router.get('/', (req, res) => {
    const q = req.query;
    res.json(listAuditLogs({
        from: q.from, to: q.to, user: q.user, role: q.role, module: q.module, action: q.action, status: q.status, limit: q.limit,
    }));
});

/**
 * POST /api/v1/audit-logs { action, module, status?, detail? }
 * For console actions that don't go through this API (exports, downloads,
 * local-only settings), so the audit trail still has them.
 */
router.post('/', asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        action: { required: true, max: 40, label: 'Action' },
        module: { required: true, max: 40, label: 'Module' },
        status: { oneOf: ['Success', 'Failed'], label: 'Status' },
        detail: { max: 500, label: 'Detail' },
    });
    audit(req, { action: body.action, module: body.module, status: body.status ?? 'Success', detail: body.detail ?? null });
    res.status(201).json({ ok: true });
}));

export default router;
