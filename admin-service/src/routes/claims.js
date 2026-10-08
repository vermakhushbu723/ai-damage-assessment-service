import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound } from '../utils/http.js';
import { authenticate, serviceKeyOrAdmin } from '../middleware/authenticate.js';
import {
    CLAIM_STAGES, CLAIM_TYPES, REGIONS, OPEN_STAGES, TRIGGER_STATUSES, COMM_CHANNELS, COMM_LOG_STATUSES,
} from '../constants.js';
import { listClaims, findClaim, upsertClaim, reassignClaims } from '../models/claimModel.js';
import { findUser } from '../models/userModel.js';
import { findRecord, insertRecord, updateRecord } from '../models/recordModel.js';
import { nextSequentialId } from '../utils/ids.js';
import { transaction } from '../db/database.js';

const router = Router();

const MAX_BATCH = 1000;
const CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9/_-]{1,40}$/;
const isDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

const CLAIM_SPEC = {
    id: { required: true, label: 'Claim id' },
    customer: { max: 100, label: 'Customer' },
    type: { oneOf: CLAIM_TYPES, label: 'Claim type' },
    handlerId: { label: 'Handler id' },
    handler: { max: 100, label: 'Handler name' },
    amount: { type: 'number', min: 0, label: 'Amount' },
    slaDays: { type: 'number', min: 0, label: 'SLA days' },
    tatMinutes: { type: 'number', min: 0, label: 'TAT minutes' },
    stage: { oneOf: CLAIM_STAGES, label: 'Stage' },
    branchId: { label: 'Branch id' },
    branch: { max: 100, label: 'Branch name' },
    region: { oneOf: REGIONS, label: 'Region' },
    intimatedAt: { label: 'Intimation date' },
    vehicleNo: { max: 30, label: 'Vehicle number' },
};

const TRIGGER_SPEC = {
    id: { label: 'Trigger id' },
    claim: { required: true, max: 40, label: 'Claim' },
    trigger: { required: true, max: 100, label: 'Trigger' },
    score: { required: true, type: 'number', min: 0, label: 'Score' },
    route: { max: 100, label: 'Route' },
    reviewer: { max: 80, label: 'Reviewer' },
    status: { oneOf: TRIGGER_STATUSES, label: 'Status' },
    at: { label: 'Raised at' },
};

const COMM_LOG_SPEC = {
    id: { label: 'Log id' },
    claim: { required: true, max: 40, label: 'Claim' },
    communication: { required: true, max: 120, label: 'Communication' },
    recipient: { required: true, max: 100, label: 'Recipient' },
    to: { max: 120, label: 'Recipient address' },
    channel: { required: true, oneOf: COMM_CHANNELS, label: 'Channel' },
    status: { required: true, oneOf: COMM_LOG_STATUSES, label: 'Status' },
    message: { max: 4000, label: 'Message' },
    at: { label: 'Sent at' },
};

function upsertRecord(collection, prefix, item) {
    const id = item.id && /^[A-Za-z0-9-]{2,60}$/.test(item.id) ? item.id : null;
    if (id && findRecord(collection, id)) {
        updateRecord(collection, id, item);
        return 'updated';
    }
    insertRecord(collection, { ...item, id: id ?? nextSequentialId('records', prefix, 1000, collection) });
    return 'created';
}

/** GET /api/v1/claims -- Claim Report, User Report, Allocation, Recommendation, Data Download. */
router.get('/', authenticate, (_req, res) => res.json(listClaims()));

router.get('/:id', authenticate, (req, res) => {
    const claim = findClaim(req.params.id);
    if (!claim) throw notFound('Claim');
    res.json(claim);
});

/**
 * POST /api/v1/claims/ingest  (header X-Service-Key, or a signed-in admin)
 * { claims?: [...], triggers?: [...], commLogs?: [...] } -- how the claim
 * systems feed the portal. Claims are created or updated by id; triggers
 * and communication logs by id when given, otherwise appended.
 */
router.post('/ingest', serviceKeyOrAdmin, asyncHandler(async (req, res) => {
    const { claims = [], triggers = [], commLogs = [] } = req.body ?? {};
    for (const [name, arr] of [['claims', claims], ['triggers', triggers], ['commLogs', commLogs]]) {
        if (!Array.isArray(arr)) throw badRequest(`${name} must be a list.`);
        if (arr.length > MAX_BATCH) throw badRequest(`At most ${MAX_BATCH} ${name} per request.`);
    }
    if (!claims.length && !triggers.length && !commLogs.length) throw badRequest('Send at least one claim, trigger or communication log.');

    const cleanClaims = claims.map((raw, i) => {
        let c;
        try {
            c = validate(raw, CLAIM_SPEC, { partial: !!findClaim(raw?.id) });
        } catch (err) {
            throw badRequest(`Claim #${i + 1}: ${err.detail}`);
        }
        if (!CLAIM_ID_RE.test(c.id)) throw badRequest(`Claim #${i + 1}: id is invalid.`);
        const isNew = !findClaim(c.id);
        if (isNew && !c.stage) throw badRequest(`Claim ${c.id}: stage is required.`);
        if (c.intimatedAt && !isDate(c.intimatedAt)) throw badRequest(`Claim ${c.id}: intimatedAt is not a valid date.`);
        if (isNew && !c.intimatedAt) c.intimatedAt = new Date().toISOString();
        if (c.intimatedAt) c.intimatedAt = new Date(c.intimatedAt).toISOString();
        return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null));
    });
    const cleanTriggers = triggers.map((raw, i) => {
        try {
            const t = validate(raw, TRIGGER_SPEC);
            if (t.at && !isDate(t.at)) throw badRequest('at is not a valid date.');
            return { status: 'Open', route: '', reviewer: '', ...Object.fromEntries(Object.entries(t).filter(([, v]) => v !== null)), at: t.at ? new Date(t.at).toISOString() : new Date().toISOString() };
        } catch (err) {
            throw badRequest(`Trigger #${i + 1}: ${err.detail}`);
        }
    });
    const cleanLogs = commLogs.map((raw, i) => {
        try {
            const l = validate(raw, COMM_LOG_SPEC);
            if (l.at && !isDate(l.at)) throw badRequest('at is not a valid date.');
            return { ...Object.fromEntries(Object.entries(l).filter(([, v]) => v !== null)), at: l.at ? new Date(l.at).toISOString() : new Date().toISOString() };
        } catch (err) {
            throw badRequest(`Communication log #${i + 1}: ${err.detail}`);
        }
    });

    const result = transaction(() => {
        const count = (arr, fn) => arr.reduce((acc, item) => { acc[fn(item)]++; return acc; }, { created: 0, updated: 0 });
        return {
            claims: count(cleanClaims, upsertClaim),
            triggers: count(cleanTriggers, (t) => upsertRecord('triggers', 'TRG', t)),
            commLogs: count(cleanLogs, (l) => upsertRecord('commLogs', 'LOG', l)),
        };
    });
    res.json(result);
}));

/**
 * POST /api/v1/claims/reassign { fromHandlerId, toHandlerId, count }
 * Allocation Load "Reasigned": moves the oldest open claims.
 */
router.post('/reassign', authenticate, asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        fromHandlerId: { required: true, label: 'From handler' },
        toHandlerId: { required: true, label: 'To handler' },
        count: { required: true, type: 'number', min: 1, label: 'Number of claims' },
    });
    if (!Number.isInteger(body.count)) throw badRequest('Number of claims must be a whole number.');
    if (body.fromHandlerId === body.toHandlerId) throw badRequest('Pick a different handler.');
    const from = findUser(body.fromHandlerId);
    const to = findUser(body.toHandlerId);
    if (!from || from.roleKey !== 'claim-handler') throw badRequest('The source handler does not exist.');
    if (!to || to.roleKey !== 'claim-handler') throw badRequest('The target handler does not exist.');
    if (to.status !== 'Active') throw badRequest(`${to.name} is not active.`);
    if (body.count > from.handlerStats.inProgress) throw badRequest(`${from.name} has only ${from.handlerStats.inProgress} open claim(s).`);
    const moved = transaction(() => reassignClaims(from.id, to.id, body.count, OPEN_STAGES));
    res.json({ moved: moved.length, claimIds: moved, from: findUser(from.id), to: findUser(to.id) });
}));

export default router;
