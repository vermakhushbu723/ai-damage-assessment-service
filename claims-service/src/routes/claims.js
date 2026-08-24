import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import {
    createClaim,
    listClaimsByRole,
    findClaimByIdForRole,
    updateClaimProgress,
    markClaimSubmitted,
    toPublicClaim,
} from '../models/claimModel.js';

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

// GET /api/v1/claims/:id -- single claim, e.g. for InspectionDetailsPage /
// DamageReviewPage to show the real insured/vehicle details instead of
// hardcoded placeholders. Role-scoped: a claim from another portal 404s,
// same as if it didn't exist -- doesn't leak whether the id is valid.
router.get('/api/v1/claims/:id', (req, res) => {
    const claim = findClaimByIdForRole(req.params.id, req.auth.role);
    if (!claim) return res.status(404).json({ detail: 'Claim not found.' });
    return res.json({ claim: toPublicClaim(claim) });
});

// PATCH /api/v1/claims/:id -- partial progress update. Used by
// DocumentUploadPage (documents) and PhotoCaptureSelectionPage /
// AddDamagePhotosPage (capturedAngles) to persist survey progress
// server-side instead of only in the browser. Body: { documents?, capturedAngles? }
// -- each replaces the whole corresponding object (the frontend sends its
// full current state, not a diff).
router.patch('/api/v1/claims/:id', (req, res) => {
    const claim = findClaimByIdForRole(req.params.id, req.auth.role);
    if (!claim) return res.status(404).json({ detail: 'Claim not found.' });

    const { documents, capturedAngles } = req.body || {};
    if (documents !== undefined && typeof documents !== 'object') {
        return res.status(400).json({ detail: '"documents" must be an object.' });
    }
    if (capturedAngles !== undefined && typeof capturedAngles !== 'object') {
        return res.status(400).json({ detail: '"capturedAngles" must be an object.' });
    }

    const updated = updateClaimProgress(req.params.id, { documents, capturedAngles });
    return res.json({ claim: toPublicClaim(updated) });
});

// POST /api/v1/claims/:id/submit -- DamageReviewPage's "Submit Survey"
// button. Marks the claim Completed with today's survey date -- this is
// what actually moves a claim from the Dashboard's "Pending Survey" count
// into "Survey Completed".
router.post('/api/v1/claims/:id/submit', (req, res) => {
    const claim = findClaimByIdForRole(req.params.id, req.auth.role);
    if (!claim) return res.status(404).json({ detail: 'Claim not found.' });

    const updated = markClaimSubmitted(req.params.id);
    return res.json({ claim: toPublicClaim(updated) });
});

export default router;
