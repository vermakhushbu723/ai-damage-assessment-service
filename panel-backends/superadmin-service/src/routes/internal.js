import { Router } from 'express';
import { HttpError } from '../utils/http.js';
import { serviceKeyMatches } from '../middleware/serviceKey.js';
import { findAdminRowByIdentifier, adminIdsByName } from '../models/adminUserModel.js';

// Calls from the other portal services, header X-Service-Key = CLAIMS_INGEST_KEY.

const router = Router();

router.use((req, _res, next) => (serviceKeyMatches(req.headers['x-service-key']) ? next() : next(new HttpError(401, 'Invalid service key.'))));

/**
 * POST /api/v1/internal/identify { identifier } -> { exists, loginId, names: [id...] }
 * The website's common login asks whether a sign-in name is a super admin's
 * (by ID / email / mobile: exists + loginId; by full name: names) before
 * sending the password here.
 */
router.post('/identify', (req, res) => {
    const identifier = String(req.body?.identifier ?? '');
    const row = findAdminRowByIdentifier(identifier);
    res.json({ exists: Boolean(row), loginId: row?.id ?? null, names: adminIdsByName(identifier) });
});

export default router;
