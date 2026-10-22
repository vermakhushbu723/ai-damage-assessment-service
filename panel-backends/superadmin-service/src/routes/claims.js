import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { settings } from '../config.js';
import { asyncHandler, validate, badRequest, notFound, HttpError } from '../utils/http.js';
import { authenticate, serviceModelOfAdmin, isMaster } from '../middleware/authenticate.js';
import { CLAIM_STATUSES, REGIONS } from '../constants.js';
import { listClaims, findClaim, upsertClaim } from '../models/claimModel.js';
import { findOrganization } from '../models/organizationModel.js';
import { transaction } from '../db/database.js';
import { audit } from '../services/audit.js';

const router = Router();

const keyMatches = (given) => {
    if (!settings.claimsIngestKey || !given) return false;
    const a = Buffer.from(String(given));
    const b = Buffer.from(settings.claimsIngestKey);
    return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * POST /api/v1/claims/ingest -- how claims reach the reports.
 * Called by the claim systems with header `X-Service-Key: <CLAIMS_INGEST_KEY>`
 * (or by the master Super Admin with a normal login token).
 * Body: { claims: [ { id, organizationId?, customer, claimType?, productType?, handler?, amount?, slaDays?,
 *                     status, intimationDate, settledAt?, branch?, region?, state?, source? } ] }
 * Existing claim ids are updated, new ones created.
 */
router.post('/ingest', (req, res, next) => {
    if (keyMatches(req.headers['x-service-key'])) {
        req.serviceCaller = { id: null, name: `service:${req.headers['x-service-name'] || 'claims'}`, role: 'Service' };
        return next();
    }
    return authenticate(req, res, () => (isMaster(req.admin) ? next() : res.status(403).json({ detail: 'Only the master Super Admin or a claim system can push claims.' })));
}, asyncHandler(async (req, res) => {
    const input = Array.isArray(req.body?.claims) ? req.body.claims : req.body?.id ? [req.body] : null;
    if (!input?.length) throw badRequest('Send { "claims": [ ... ] } with at least one claim.');
    if (input.length > 1000) throw badRequest('At most 1000 claims per request.');

    const rows = input.map((raw, i) => {
        let c;
        try {
            c = validate(raw, {
                id: { required: true, max: 60, label: 'id' },
                organizationId: { label: 'organizationId' },
                customer: { required: true, max: 120, label: 'customer' },
                claimType: { max: 60, label: 'claimType' },
                productType: { max: 60, label: 'productType' },
                handler: { max: 80, label: 'handler' },
                amount: { type: 'number', min: 0, label: 'amount' },
                slaDays: { type: 'number', min: 0, label: 'slaDays' },
                status: { required: true, oneOf: CLAIM_STATUSES, label: 'status' },
                intimationDate: { required: true, label: 'intimationDate' },
                settledAt: { label: 'settledAt' },
                branch: { max: 80, label: 'branch' },
                region: { oneOf: REGIONS, label: 'region' },
                state: { max: 60, label: 'state' },
                source: { max: 60, label: 'source' },
            });
        } catch (err) {
            throw new HttpError(400, `Claim #${i + 1}: ${err.detail}`);
        }
        for (const k of ['intimationDate', 'settledAt']) {
            if (c[k] && Number.isNaN(Date.parse(c[k]))) throw badRequest(`Claim ${c.id}: ${k} is not a valid date.`);
            if (c[k]) c[k] = new Date(c[k]).toISOString();
        }
        if (c.organizationId && !findOrganization(c.organizationId)) throw badRequest(`Claim ${c.id}: organization ${c.organizationId} does not exist.`);
        return { ...c, amount: Math.round(c.amount ?? 0) };
    });

    const counts = transaction(() => rows.reduce((acc, c) => {
        acc[upsertClaim(c)]++;
        return acc;
    }, { created: 0, updated: 0 }));
    audit(req, { action: 'Created', module: 'Claims', detail: `Claims ingested: ${counts.created} new, ${counts.updated} updated`, actor: req.admin ?? req.serviceCaller });
    res.status(201).json(counts);
}));

router.use(authenticate);

/** GET /api/v1/claims -> claims of the organizations this admin manages (newest first). */
router.get('/', (req, res) => {
    const own = serviceModelOfAdmin(req.admin);
    // Claims not linked to an organization are only visible to the master admin.
    res.json(own ? listClaims(own) : listClaims(null));
});

router.get('/:id', (req, res) => {
    const claim = findClaim(req.params.id);
    const own = serviceModelOfAdmin(req.admin);
    if (!claim || (own && claim.serviceModel !== own)) throw notFound('Claim');
    res.json(claim);
});

export default router;
