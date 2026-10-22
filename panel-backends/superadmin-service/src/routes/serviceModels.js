import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound, conflict } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import { SERVICE_TYPES, APPLICABLE_FOR, PRIORITIES, SERVICE_MODEL_STATUSES } from '../constants.js';
import {
    listServiceModels, findServiceModel, insertServiceModel, updateServiceModel, serviceModelNameTaken,
} from '../models/serviceModelModel.js';
import { nextSequentialId } from '../utils/ids.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(authenticate);

const WORKING_HOURS_RE = /^(0[1-9]|1[0-2]):[0-5]\d (AM|PM) - (0[1-9]|1[0-2]):[0-5]\d (AM|PM)$/;
const SPEC = {
    name: { required: true, min: 2, max: 80, label: 'Service model name' },
    serviceType: { required: true, oneOf: SERVICE_TYPES, label: 'Service type' },
    applicableFor: { required: true, oneOf: APPLICABLE_FOR, label: 'Applicable for' },
    description: { max: 500, label: 'Description' },
    sla: { required: true, type: 'number', min: 1, label: 'SLA/TAT' },
    workingHours: { required: true, label: 'Working hours' },
    escalationAfter: { required: true, max: 30, label: 'Escalation after' },
    escalationTo: { required: true, max: 80, label: 'Escalation to' },
    priority: { required: true, oneOf: PRIORITIES, label: 'Priority' },
    status: { oneOf: SERVICE_MODEL_STATUSES, label: 'Status' },
};

function checkFields(body) {
    if (body.workingHours && !WORKING_HOURS_RE.test(body.workingHours)) throw badRequest('Working hours must look like "09:00 AM - 06:00 PM".');
    if (body.sla && (!Number.isInteger(body.sla) || body.sla > 720)) throw badRequest('SLA/TAT must be a whole number of hours up to 720.');
}

/** GET /api/v1/service-models */
router.get('/', (_req, res) => res.json(listServiceModels()));

router.get('/:id', (req, res) => {
    const model = findServiceModel(req.params.id);
    if (!model) throw notFound('Service model');
    res.json(model);
});

/** POST /api/v1/service-models -- "Create Service Model". */
router.post('/', asyncHandler(async (req, res) => {
    const body = validate(req.body, SPEC);
    checkFields(body);
    if (serviceModelNameTaken(body.name)) throw conflict(`A service model named "${body.name}" already exists.`);
    const model = insertServiceModel({ ...body, id: nextSequentialId('service_models', 'SM', 100), status: body.status ?? 'Active', createdBy: req.admin.id });
    audit(req, { action: 'Created', module: 'Settings', detail: `Service model ${model.id} ${model.name}` });
    res.status(201).json(model);
}));

/** PATCH /api/v1/service-models/:id -- "Update Service Model". */
router.patch('/:id', asyncHandler(async (req, res) => {
    const current = findServiceModel(req.params.id);
    if (!current) throw notFound('Service model');
    const patch = validate(req.body, SPEC, { partial: true });
    checkFields(patch);
    if (patch.name && serviceModelNameTaken(patch.name, current.id)) throw conflict(`A service model named "${patch.name}" already exists.`);
    const model = updateServiceModel(current.id, patch);
    audit(req, { action: 'Updated', module: 'Settings', detail: `Service model ${current.id}: ${Object.keys(patch).join(', ')}` });
    res.json(model);
}));

export default router;
