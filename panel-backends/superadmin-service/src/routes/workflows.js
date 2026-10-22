import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound, forbidden } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import {
    MODES, OPERATING_MODELS, ADMIN_PROFILES, FEE_BILL_MODELS, CHANNELS, AUTO_ROLES, SERVICE_MODEL_OF_MODE,
} from '../constants.js';
import { getWorkflowConfig, saveWorkflowConfig, workflowStats } from '../models/workflowModel.js';
import { listOrganizations } from '../models/organizationModel.js';
import { audit } from '../services/audit.js';
import { randomToken } from '../utils/ids.js';

const router = Router();
router.use(authenticate);

const MODE_LABEL = { saas: 'SaaS', serviceProvider: 'Service Provider' };

/** Modes this admin may see/change: master -> both, scoped admin -> their own. */
const modesOf = (admin) => (admin.scope === 'all' ? MODES : MODES.filter((m) => m === admin.scope));

function loadMode(req) {
    const { mode } = req.params;
    if (!MODES.includes(mode)) throw notFound('Workflow mode');
    if (!modesOf(req.admin).includes(mode)) throw forbidden(`You can only manage the ${MODE_LABEL[req.admin.scope]} workflow.`);
    return { mode, config: getWorkflowConfig(mode) };
}

const withStats = (mode, config) => ({ ...config, mode, stats: workflowStats(mode, config) });

/** GET /api/v1/workflows -> { saas?: config, serviceProvider?: config, options } */
router.get('/', (req, res) => {
    const result = Object.fromEntries(modesOf(req.admin).map((m) => [m, withStats(m, getWorkflowConfig(m))]));
    res.json({ ...result, options: { operatingModels: OPERATING_MODELS, adminProfiles: ADMIN_PROFILES, feeBillModels: FEE_BILL_MODELS, channels: CHANNELS, autoRoles: AUTO_ROLES } });
});

function normalizeRules(input, config) {
    if (!Array.isArray(input) || input.length !== config.rules.length) throw badRequest('rules must list every stage of this workflow.');
    return config.rules.map((current) => {
        const next = input.find((r) => r?.stage === current.stage);
        if (!next) throw badRequest(`Missing rule for stage "${current.stage}".`);
        const enabled = Boolean(next.enabled);
        // A disabled stage can't grant anything.
        return { ...current, enabled, view: enabled && Boolean(next.view), edit: enabled && Boolean(next.edit), approve: enabled && Boolean(next.approve) };
    });
}

function normalizeOverview(input, config, mode) {
    const o = validate(input, {
        operatingModel: { oneOf: OPERATING_MODELS, label: 'Operating model' },
        insurer: { max: 150, label: 'Insurer/Partner' },
        adminProfile: { oneOf: ADMIN_PROFILES, label: 'Admin profile' },
        feeBillModel: { oneOf: FEE_BILL_MODELS, label: 'Fee bill model' },
    }, { partial: true });
    if (o.insurer && !listOrganizations(SERVICE_MODEL_OF_MODE[mode]).some((org) => org.name === o.insurer)) {
        throw badRequest(`Insurer/Partner "${o.insurer}" is not a ${MODE_LABEL[mode]} organization.`);
    }
    if (mode === 'saas' && o.feeBillModel && o.feeBillModel !== 'Not Applicable-SaaS') throw badRequest('Fee bill does not apply to the SaaS workflow.');
    return { ...config.overview, ...o };
}

/** PATCH /api/v1/workflows/:mode { rules?, overview?, autoRoles? } -- Save Rules / Save Configuration / Manage. */
router.patch('/:mode', asyncHandler(async (req, res) => {
    const { mode, config } = loadMode(req);
    const next = { ...config };
    const changed = [];
    if (req.body?.rules !== undefined) { next.rules = normalizeRules(req.body.rules, config); changed.push('stage rules'); }
    if (req.body?.overview !== undefined) { next.overview = normalizeOverview(req.body.overview, config, mode); changed.push('business model'); }
    if (req.body?.autoRoles !== undefined) {
        const roles = req.body.autoRoles;
        if (!Array.isArray(roles) || roles.some((r) => !AUTO_ROLES.includes(r))) throw badRequest(`autoRoles must be from: ${AUTO_ROLES.join(', ')}.`);
        next.autoRoles = [...new Set(roles)];
        changed.push('automatic roles');
    }
    if (!changed.length) throw badRequest('Nothing to update.');
    const saved = saveWorkflowConfig(mode, next, req.admin.id);
    audit(req, { action: 'Updated', module: 'Settings', detail: `${MODE_LABEL[mode]} workflow: ${changed.join(', ')}` });
    res.json(withStats(mode, saved));
}));

/** POST /api/v1/workflows/:mode/activate -- "Activate configuration". */
router.post('/:mode/activate', asyncHandler(async (req, res) => {
    const { mode, config } = loadMode(req);
    if (!config.rules.some((r) => r.enabled)) throw badRequest('Enable at least one stage before activating.');
    const saved = saveWorkflowConfig(mode, { ...config, activatedAt: new Date().toISOString(), activatedBy: req.admin.name }, req.admin.id);
    audit(req, { action: 'Updated', module: 'Settings', detail: `${MODE_LABEL[mode]} workflow activated` });
    res.json(withStats(mode, saved));
}));

function normalizeTrigger(body, config, partial) {
    const t = validate(body, {
        trigger: { required: true, min: 2, max: 80, label: 'Trigger' },
        stage: { required: true, label: 'Stage' },
        recipient: { required: true, min: 2, max: 80, label: 'Recipient' },
        channels: { required: true, type: 'array', label: 'Channels' },
        status: { oneOf: ['Active', 'Inactive'], label: 'Status' },
    }, { partial });
    if (t.stage && !config.stages.includes(t.stage)) throw badRequest(`Stage must be one of: ${config.stages.join(', ')}.`);
    if (t.channels) {
        if (!t.channels.length || t.channels.some((c) => !CHANNELS.includes(c))) throw badRequest(`Channels must be from: ${CHANNELS.join(', ')}.`);
        t.channels = [...new Set(t.channels)].join('+');
    }
    return t;
}

/** POST /api/v1/workflows/:mode/triggers -- Communication Triggers "Add Role". */
router.post('/:mode/triggers', asyncHandler(async (req, res) => {
    const { mode, config } = loadMode(req);
    const t = normalizeTrigger(req.body, config, false);
    const trigger = { id: `t-${randomToken().slice(0, 8)}`, status: 'Active', ...t };
    const saved = saveWorkflowConfig(mode, { ...config, triggers: [...config.triggers, trigger] }, req.admin.id);
    audit(req, { action: 'Created', module: 'Settings', detail: `${MODE_LABEL[mode]} trigger "${trigger.trigger}"` });
    res.status(201).json(withStats(mode, saved));
}));

/** PATCH /api/v1/workflows/:mode/triggers/:id -- Communication Triggers "Edit". */
router.patch('/:mode/triggers/:id', asyncHandler(async (req, res) => {
    const { mode, config } = loadMode(req);
    const current = config.triggers.find((t) => t.id === req.params.id);
    if (!current) throw notFound('Trigger');
    const t = normalizeTrigger(req.body, config, true);
    const saved = saveWorkflowConfig(mode, { ...config, triggers: config.triggers.map((x) => (x.id === current.id ? { ...x, ...t } : x)) }, req.admin.id);
    audit(req, { action: 'Updated', module: 'Settings', detail: `${MODE_LABEL[mode]} trigger "${current.trigger}"` });
    res.json(withStats(mode, saved));
}));

export default router;
