import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound } from '../utils/http.js';
import { authenticate, requireMaster } from '../middleware/authenticate.js';
import { INTEGRATION_TYPES, ENVIRONMENTS } from '../constants.js';
import { listIntegrations, findIntegration, findIntegrationRow, updateIntegration } from '../models/integrationModel.js';
import { insertActivity } from '../models/systemModel.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(authenticate);

const SLOW_MS = 2000;
const TIMEOUT_MS = 8000;

/** GET /api/v1/integrations */
router.get('/', (_req, res) => res.json(listIntegrations()));

/** PATCH /api/v1/integrations/:id (master) -- "Configure"/"Edit": { endpoint, apiKey?, type?, environment? } */
router.patch('/:id', requireMaster, asyncHandler(async (req, res) => {
    const current = findIntegration(req.params.id);
    if (!current) throw notFound('Integration');
    const patch = validate(req.body, {
        endpoint: { max: 500, label: 'Endpoint URL' },
        apiKey: { max: 500, label: 'API key' },
        type: { oneOf: INTEGRATION_TYPES, label: 'Type' },
        environment: { oneOf: ENVIRONMENTS, label: 'Environment' },
    }, { partial: true });
    if (patch.endpoint) {
        let url;
        try {
            url = new URL(patch.endpoint);
        } catch {
            throw badRequest('Endpoint URL is not a valid URL.');
        }
        if (!['http:', 'https:'].includes(url.protocol)) throw badRequest('Endpoint URL must start with http:// or https://.');
    }
    if (patch.apiKey === '') delete patch.apiKey; // empty field in the form = keep the stored key
    // A new endpoint has not been tested yet.
    if (patch.endpoint !== undefined && patch.endpoint !== current.endpoint) Object.assign(patch, { status: patch.endpoint ? 'Not Tested' : 'Not Configured', responseMs: null, lastError: null });
    const updated = updateIntegration(current.id, patch);
    insertActivity({ user: req.admin.name, activity: `Updated ${current.name} configuration`, module: 'API Integration' });
    audit(req, { action: 'Updated', module: 'System', detail: `Integration ${current.id}: ${Object.keys(patch).filter((k) => k !== 'apiKey').join(', ')}${patch.apiKey ? ', apiKey' : ''}` });
    res.json(updated);
}));

/**
 * POST /api/v1/integrations/:id/test -- "Test": calls the configured endpoint
 * (GET, API key sent as Bearer + X-API-Key) and records the result:
 * Connected (< 2 s, no 5xx), Warning (slow or 4xx), Failed (unreachable, timeout or 5xx).
 */
router.post('/:id/test', asyncHandler(async (req, res) => {
    const row = findIntegrationRow(req.params.id);
    if (!row) throw notFound('Integration');
    if (!row.endpoint) throw badRequest('Configure an endpoint URL first.');

    const started = Date.now();
    let status;
    let error = null;
    let httpStatus = null;
    try {
        const headers = row.api_key ? { Authorization: `Bearer ${row.api_key}`, 'X-API-Key': row.api_key } : {};
        const response = await fetch(row.endpoint, { method: 'GET', headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
        httpStatus = response.status;
        await response.arrayBuffer().catch(() => {});
        const ms = Date.now() - started;
        if (response.status >= 500) { status = 'Failed'; error = `HTTP ${response.status}`; }
        else if (response.status >= 400 || ms > SLOW_MS) { status = 'Warning'; error = response.status >= 400 ? `HTTP ${response.status}` : `Slow response (${(ms / 1000).toFixed(1)} s)`; }
        else status = 'Connected';
    } catch (err) {
        status = 'Failed';
        error = err.name === 'TimeoutError' ? `No response in ${TIMEOUT_MS / 1000} s` : (err.cause?.code || err.message);
    }
    const responseMs = Date.now() - started;
    const updated = updateIntegration(row.id, { status, responseMs, lastError: error, lastSync: new Date().toISOString() });
    insertActivity({ user: req.admin.name, activity: `Tested ${row.name}: ${status}${error ? ` (${error})` : ''}`, module: 'API Integration', status: status === 'Failed' ? 'Failed' : 'Success' });
    audit(req, { action: 'Updated', module: 'System', status: status === 'Failed' ? 'Failed' : 'Success', detail: `Integration test ${row.id}: ${status}${error ? ` (${error})` : ''}` });
    res.json({ ...updated, httpStatus });
}));

export default router;
