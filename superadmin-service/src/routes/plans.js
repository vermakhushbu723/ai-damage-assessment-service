import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound } from '../utils/http.js';
import { authenticate, serviceModelOfAdmin } from '../middleware/authenticate.js';
import { listPlans, findPlan, updatePlan } from '../models/planModel.js';
import { findOrganization, setPlanForOrganizations } from '../models/organizationModel.js';
import { transaction } from '../db/database.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(authenticate);

/** GET /api/v1/plans -> plan catalog with a live subscriber count per plan. */
router.get('/', (_req, res) => res.json(listPlans()));

/** PATCH /api/v1/plans/:id -- "Edit Plan": { name?, price?, priceLabel?, userLimit?, features? } */
router.patch('/:id', asyncHandler(async (req, res) => {
    const plan = findPlan(req.params.id);
    if (!plan) throw notFound('Plan');
    const patch = validate(req.body, {
        name: { min: 2, max: 60, label: 'Plan name' },
        price: { type: 'number', min: 0, label: 'Price' },
        priceLabel: { max: 60, label: 'Price label' },
        userLimit: { min: 2, max: 80, label: 'User limit text' },
        features: { type: 'array', label: 'Features' },
    }, { partial: true });
    if (patch.features) {
        patch.features = patch.features.map((f) => String(f).trim()).filter(Boolean);
        if (!patch.features.length) throw badRequest('A plan needs at least one feature.');
    }
    const updated = updatePlan(plan.id, patch);
    audit(req, { action: 'Updated', module: 'Settings', detail: `Plan ${plan.id}: ${Object.keys(patch).join(', ')}` });
    res.json(updated);
}));

/** POST /api/v1/plans/:id/assign { organizationIds: [...] } -- "Select Plan". */
router.post('/:id/assign', asyncHandler(async (req, res) => {
    const plan = findPlan(req.params.id);
    if (!plan) throw notFound('Plan');
    const ids = Array.isArray(req.body?.organizationIds) ? [...new Set(req.body.organizationIds.map(String))] : [];
    if (!ids.length) throw badRequest('Select at least one organization.');
    const own = serviceModelOfAdmin(req.admin);
    for (const id of ids) {
        const org = findOrganization(id);
        if (!org || (own && org.serviceModel !== own)) throw badRequest(`Organization ${id} not found.`);
    }
    transaction(() => setPlanForOrganizations(ids, plan.id));
    audit(req, { action: 'Updated', module: 'Organizations', detail: `Plan ${plan.id} assigned to ${ids.join(', ')}` });
    res.json({ plan: findPlan(plan.id), organizationIds: ids });
}));

export default router;
