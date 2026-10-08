import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound, conflict, normalizePhone } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import {
    STATES, BRANCH_STATUSES, BRANCH_CLASSES, TEMPLATE_CATEGORIES, ACTIVE_INACTIVE, COMM_STAGES, COMM_CHANNELS, COMM_RECIPIENTS,
    SEND_TIMINGS, REMINDER_OPTIONS, SEVERITIES, FRAUD_STAGES, TRIGGER_STATUSES,
} from '../constants.js';
import { listRecords, findRecord, insertRecord, updateRecord, deleteRecord } from '../models/recordModel.js';
import { nextSequentialId } from '../utils/ids.js';

// The configuration lists of the portal, all stored in `records`. Each
// definition below is one REST resource:
//   GET    /<path>          list
//   POST   /<path>          create   (when `create`)
//   PATCH  /<path>/:id      update   (fields in `editable`, default: all of `spec`)
//   DELETE /<path>/:id      remove   (when `remove`)
// `check(item, current)` adds rules the field spec can't express.

const ID_RE = /^[A-Z]{2,5}-[A-Za-z0-9-]{1,40}$/;
const listOf = (allowed, label) => (v) => {
    if (v && v.some((x) => !allowed.includes(x))) throw badRequest(`${label} must be from: ${allowed.join(', ')}.`);
};
const notEmpty = (v, label) => {
    if (Array.isArray(v) && !v.length) throw badRequest(`Select at least one ${label}.`);
};

export const RESOURCES = [
    {
        path: '/branches',
        collection: 'branches',
        prefix: 'BR',
        create: true,
        spec: {
            name: { required: true, max: 80, label: 'Branch name' },
            organization: { required: true, max: 80, label: 'Organization' },
            class: { required: true, oneOf: BRANCH_CLASSES, label: 'Class' },
            city: { required: true, max: 60, label: 'City' },
            state: { required: true, oneOf: STATES, label: 'State' },
            contact: { required: true, phone: true, label: 'Contact number' },
            status: { required: true, oneOf: BRANCH_STATUSES, label: 'Status' },
            address: { required: true, max: 300, label: 'Address' },
        },
        check: (item, current) => {
            if (item.contact) item.contact = normalizePhone(item.contact);
            const name = item.name ?? current?.name;
            if (item.name && listRecords('branches').some((b) => b.id !== current?.id && b.name.toLowerCase() === name.toLowerCase())) {
                throw conflict('A branch with this name already exists.');
            }
        },
    },
    {
        path: '/document-templates',
        collection: 'documentTemplates',
        prefix: 'TPL',
        create: true,
        spec: {
            name: { required: true, max: 100, label: 'Template name' },
            category: { required: true, oneOf: TEMPLATE_CATEGORIES, label: 'Category' },
            status: { required: true, oneOf: ACTIVE_INACTIVE, label: 'Status' },
            body: { required: true, min: 20, max: 20000, label: 'Template content' },
            branchIds: { type: 'array', label: 'Branches' },
            version: { max: 10, label: 'Version' },
        },
        check: (item) => {
            if (item.version && !/^\d+\.\d+$/.test(item.version)) throw badRequest('Version must look like 1.0.');
            if (item.branchIds?.some((id) => !findRecord('branches', id))) throw badRequest('One of the selected branches does not exist.');
        },
        defaults: { version: '1.0', branchIds: [] },
    },
    {
        path: '/comm-rules',
        collection: 'commRules',
        prefix: 'CR',
        create: true,
        remove: true,
        order: 'asc',
        spec: {
            stage: { required: true, oneOf: COMM_STAGES, label: 'Stage' },
            trigger: { required: true, max: 100, label: 'Trigger/Event' },
            template: { required: true, max: 100, label: 'Template' },
            recipients: { required: true, type: 'array', label: 'Recipients' },
            channels: { required: true, type: 'array', label: 'Channels' },
            initialSend: { required: true, oneOf: SEND_TIMINGS, label: 'Initial send' },
            reminder: { required: true, oneOf: REMINDER_OPTIONS, label: 'Reminder' },
            status: { required: true, oneOf: ACTIVE_INACTIVE, label: 'Status' },
        },
        check: (item) => {
            listOf(COMM_RECIPIENTS, 'Recipients')(item.recipients);
            listOf(COMM_CHANNELS, 'Channels')(item.channels);
            notEmpty(item.recipients, 'recipient');
            notEmpty(item.channels, 'channel');
        },
    },
    {
        path: '/comm-templates',
        collection: 'commTemplates',
        prefix: 'CT',
        create: true,
        remove: true,
        order: 'asc',
        spec: {
            name: { required: true, max: 100, label: 'Template name' },
            channel: { required: true, max: 100, label: 'Channel(s)' },
            body: { required: true, max: 4000, label: 'Message' },
            status: { oneOf: ACTIVE_INACTIVE, label: 'Status' },
        },
        check: (item, current) => {
            if (item.name && listRecords('commTemplates').some((t) => t.id !== current?.id && t.name.toLowerCase() === item.name.toLowerCase())) {
                throw conflict('A template with this name already exists.');
            }
        },
        defaults: { status: 'Active' },
    },
    {
        // The four delivery channels: switch on/off, provider and sender details.
        path: '/channels',
        collection: 'channels',
        prefix: 'CH',
        order: 'asc',
        spec: {
            enabled: { type: 'boolean', label: 'Enabled' },
            provider: { max: 80, label: 'Provider' },
            senderId: { max: 80, label: 'Sender ID' },
        },
    },
    {
        path: '/fraud-rules',
        collection: 'fraudRules',
        prefix: 'FR',
        create: true,
        remove: true,
        order: 'asc',
        spec: {
            rule: { required: true, max: 100, label: 'Rule' },
            stage: { required: true, oneOf: FRAUD_STAGES, label: 'Stage' },
            severity: { required: true, oneOf: SEVERITIES, label: 'Severity' },
            score: { required: true, type: 'number', min: 1, label: 'Score' },
            condition: { required: true, max: 200, label: 'Condition' },
            action: { required: true, max: 100, label: 'Action' },
            threshold: { type: 'number', min: 0, label: 'Threshold' },
            active: { type: 'boolean', label: 'Active' },
            pending: { type: 'boolean', label: 'Draft' },
            key: { max: 40, label: 'Rule key' },
        },
        check: (item) => {
            if (item.score > 100) throw badRequest('Score must be at most 100.');
        },
        defaults: { active: true },
    },
    {
        path: '/authority-matrix',
        collection: 'authorityMatrix',
        prefix: 'AU',
        create: true,
        remove: true,
        order: 'asc',
        spec: {
            role: { required: true, max: 60, label: 'Role' },
            motorOD: { required: true, max: 40, label: 'Motor OD' },
            fire: { required: true, max: 40, label: 'Fire' },
            other: { required: true, max: 40, label: 'Other' },
        },
    },
    {
        // Approval Logic > History: one row per published rule (stamped by the server).
        path: '/approval-history',
        collection: 'approvalHistory',
        prefix: 'AH',
        create: true,
        editable: [],
        spec: {
            rule: { required: true, max: 100, label: 'Rule' },
            status: { oneOf: ['Published', 'Draft', 'Rejected'], label: 'Status' },
        },
        stamp: (req) => ({ date: new Date().toISOString(), changedBy: req.admin.name }),
        defaults: { status: 'Published' },
    },
    {
        // System Settings > activity table (Audit & Compliance / System Update).
        path: '/compliance-log',
        collection: 'complianceLog',
        prefix: 'CL',
        create: true,
        editable: [],
        spec: {
            activity: { required: true, max: 200, label: 'Activity' },
            module: { required: true, max: 60, label: 'Module' },
            status: { oneOf: ['Success', 'Failed', 'Approval Log'], label: 'Status' },
        },
        stamp: (req) => ({ at: new Date().toISOString(), user: req.admin.name }),
        defaults: { status: 'Success' },
    },
    {
        // Trigger History: raised by the claim systems (POST /claims/ingest); reviewers change the status here.
        path: '/triggers',
        collection: 'triggers',
        prefix: 'TRG',
        editable: ['status', 'reviewer'],
        spec: {
            status: { oneOf: TRIGGER_STATUSES, label: 'Status' },
            reviewer: { max: 80, label: 'Reviewer' },
        },
    },
];

function buildRouter(def) {
    const router = Router();
    const editable = def.editable ?? Object.keys(def.spec);
    const editSpec = Object.fromEntries(Object.entries(def.spec).filter(([k]) => editable.includes(k)));

    router.get('/', (_req, res) => res.json(listRecords(def.collection, { order: def.order })));

    router.get('/:id', (req, res) => {
        const item = findRecord(def.collection, req.params.id);
        if (!item) throw notFound('Item');
        res.json(item);
    });

    if (def.create) {
        router.post('/', asyncHandler(async (req, res) => {
            const item = { ...def.defaults, ...validate(req.body, def.spec) };
            for (const [k, v] of Object.entries(def.defaults ?? {})) if (item[k] === null) item[k] = v;
            def.check?.(item, null);
            // The portal may pick the id itself (it shows the item straight away); otherwise PREFIX-1001, ...
            const wanted = typeof req.body?.id === 'string' && ID_RE.test(req.body.id) ? req.body.id : null;
            if (wanted && findRecord(def.collection, wanted)) throw conflict(`An item with id ${wanted} already exists.`);
            const id = wanted ?? nextSequentialId('records', def.prefix, 1000, def.collection);
            res.status(201).json(insertRecord(def.collection, { ...item, ...def.stamp?.(req), id }));
        }));
    }

    if (editable.length) {
        router.patch('/:id', asyncHandler(async (req, res) => {
            const current = findRecord(def.collection, req.params.id);
            if (!current) throw notFound('Item');
            const patch = validate(req.body, editSpec, { partial: true });
            for (const [k, rule] of Object.entries(editSpec)) {
                if (rule.required && k in patch && (patch[k] === null || (Array.isArray(patch[k]) && !patch[k].length && rule.type !== 'array'))) {
                    throw badRequest(`${rule.label} is required.`);
                }
            }
            def.check?.(patch, current);
            res.json(updateRecord(def.collection, current.id, patch));
        }));
    }

    if (def.remove) {
        router.delete('/:id', asyncHandler(async (req, res) => {
            if (!deleteRecord(def.collection, req.params.id)) throw notFound('Item');
            res.json({ ok: true });
        }));
    }
    return router;
}

/** Mounts every configuration-list resource on the /api/v1 router (each behind sign-in). */
export function mountResources(api) {
    for (const def of RESOURCES) api.use(def.path, authenticate, buildRouter(def));
}
