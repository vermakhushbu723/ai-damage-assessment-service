import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import { ENVIRONMENTS } from '../constants.js';
import { findRecord, updateRecord } from '../models/recordModel.js';
import { listIntegrations, testIntegration, toIntegrationDto } from '../services/integrations.js';

const router = Router();
router.use(authenticate);

/** GET /api/v1/integrations */
router.get('/', (_req, res) => res.json(listIntegrations()));

/** PATCH /api/v1/integrations/:id { endpoint, type, env, apiKey?, retry? } -- Configure / Edit. */
router.patch('/:id', asyncHandler(async (req, res) => {
    const current = findRecord('integrations', req.params.id);
    if (!current) throw notFound('Integration');
    const patch = validate(req.body, {
        endpoint: { max: 500, label: 'Endpoint URL' },
        type: { max: 40, label: 'Type' },
        env: { oneOf: ENVIRONMENTS, label: 'Environment' },
        apiKey: { max: 500, label: 'API key' },
        retry: { type: 'boolean', label: 'Retry on failure' },
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
    if (!patch.apiKey) delete patch.apiKey; // empty field = keep the stored key
    if (patch.type === null) delete patch.type;
    // A changed endpoint has not been tested yet.
    if ('endpoint' in patch && patch.endpoint !== current.endpoint) {
        Object.assign(patch, { endpoint: patch.endpoint ?? '', status: patch.endpoint ? 'Not Tested' : 'Not Configured', responseSec: null, lastError: null });
    }
    res.json(toIntegrationDto(updateRecord('integrations', current.id, patch)));
}));

/** POST /api/v1/integrations/:id/test -- real HTTP call to the endpoint. */
router.post('/:id/test', asyncHandler(async (req, res) => {
    const it = findRecord('integrations', req.params.id);
    if (!it) throw notFound('Integration');
    if (!it.endpoint) throw badRequest('Configure an endpoint URL first.');
    res.json(await testIntegration(it.id));
}));

export default router;
