import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { createClaim, listClaimsByRole, toPublicClaim } from '../models/claimModel.js';

const router = Router();

// All claims routes require a valid login (see ../auth-service) -- every
// claim is scoped to req.auth.role + req.auth.sub.
router.use(authenticate);

// POST /api/v1/claims -- creates a claim from the Owner & Vehicle Details
// form. `role`/`created_by_*` come from the token, never from the request
// body, so a portal can't create a claim under another portal's name.
router.post('/api/v1/claims', (req, res) => {
    const form = req.body || {};

    if (!form.ownerName?.trim()) return res.status(400).json({ detail: '"ownerName" is required.' });
    if (!form.registrationNumber?.trim()) return res.status(400).json({ detail: '"registrationNumber" is required.' });

    const claim = createClaim({
        role: req.auth.role,
        userId: req.auth.sub,
        username: req.auth.username,
        form,
    });

    return res.status(201).json({ claim: toPublicClaim(claim) });
});

// GET /api/v1/claims -- lists claims for the calling portal only (role
// scoped, see models/claimModel.js's listClaimsByRole) plus ready-made
// counts for the dashboard's stat cards. Optional ?status=Pending|Completed
// narrows the list without changing the counts (counts always reflect all
// of this portal's claims).
router.get('/api/v1/claims', (req, res) => {
    const rows = listClaimsByRole(req.auth.role);
    const claims = rows.map(toPublicClaim);

    const counts = {
        total: claims.length,
        completed: claims.filter((c) => c.status === 'Completed').length,
        pending: claims.filter((c) => c.status === 'Pending').length,
    };

    const { status } = req.query;
    const filtered = status ? claims.filter((c) => c.status === status) : claims;

    return res.json({ claims: filtered, counts });
});

export default router;
