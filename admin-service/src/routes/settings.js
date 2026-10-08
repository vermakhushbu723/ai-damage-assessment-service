import { Router } from 'express';
import { settings as env } from '../config.js';
import { asyncHandler, badRequest, notFound } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import {
    JOURNEY_STAGES, SEVERITIES, APPROVAL_STAGES, APPROVAL_ACTIONS, PAYEE_TYPES, RETENTION_OPTIONS,
} from '../constants.js';
import { getSetting, setSetting, SETTING_KEYS } from '../models/settingsModel.js';
import { listRecords } from '../models/recordModel.js';
import { listClaims } from '../models/claimModel.js';

// Single configuration documents edited by the portal's switches and
// matrices. GET returns them all (plus computed figures); PUT /:key replaces
// one after a shape check. Server-owned parts (versions, stats) are ignored on PUT.

const router = Router();
router.use(authenticate);

const MAX_BYTES = 200 * 1024;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const need = (cond, msg) => { if (!cond) throw badRequest(msg); };
const bool = (v, label) => need(typeof v === 'boolean', `${label} must be true or false.`);
const text = (v, label, max = 200) => need(typeof v === 'string' && v.trim() && v.length <= max, `${label} is required (max ${max} characters).`);
const list = (v, label, each) => {
    need(Array.isArray(v), `${label} must be a list.`);
    const ids = new Set();
    v.forEach((item, i) => {
        need(isObj(item) && typeof item.id === 'string' && item.id, `${label} #${i + 1} needs an id.`);
        need(!ids.has(item.id), `${label} has a duplicate id ${item.id}.`);
        ids.add(item.id);
        each(item, `${label} "${item.id}"`);
    });
};
const switches = (obj, keys, label) => {
    need(isObj(obj), `${label} must be an object.`);
    keys.forEach((k) => bool(obj[k], `${label}.${k}`));
    return Object.fromEntries(keys.map((k) => [k, obj[k]]));
};

/** Per document: validate and return what is stored. */
const SHAPES = {
    config: (v) => {
        const claimFlow = switches(v.claimFlow, ['recommendationEngine', 'autoApproval'], 'claimFlow');
        const approval = switches(v.approval, ['ila', 'fla'], 'approval');
        const fraud = switches(v.fraud, ['autoApprove'], 'fraud');
        need(isObj(v.journey) && ['saas', 'full'].includes(v.journey.mode), 'journey.mode must be saas or full.');
        need(isObj(v.journey.enabled), 'journey.enabled is required.');
        const enabled = {};
        for (const mode of ['saas', 'full']) {
            const m = v.journey.enabled[mode];
            need(isObj(m), `journey.enabled.${mode} is required.`);
            enabled[mode] = Object.fromEntries(JOURNEY_STAGES[mode].map((s) => [s, s === 'Intimation' ? true : m[s] !== false]));
        }
        list(v.approvalRules, 'Approval rule', (r, l) => {
            text(r.title, `${l} name`, 100);
            need(SEVERITIES.includes(r.severity), `${l} severity must be one of: ${SEVERITIES.join(', ')}.`);
            need(APPROVAL_STAGES.includes(r.stage), `${l} stage must be one of: ${APPROVAL_STAGES.join(', ')}.`);
            need(APPROVAL_ACTIONS.includes(r.action), `${l} action must be one of: ${APPROVAL_ACTIONS.join(', ')}.`);
            text(r.condition, `${l} condition`);
            bool(r.enabled, `${l} enabled`);
            need(r.threshold == null || (typeof r.threshold === 'number' && r.threshold >= 0), `${l} threshold must be a positive number.`);
        });
        list(v.approvalMatrix, 'Approval matrix row', (r, l) => {
            text(r.approval, `${l} approval`);
            text(r.logic, `${l} logic`);
            bool(r.enabled, `${l} enabled`);
        });
        return { claimFlow, approval, fraud, journey: { mode: v.journey.mode, enabled }, approvalRules: v.approvalRules, approvalMatrix: v.approvalMatrix };
    },
    routing: (v) => {
        list(v.matrix, 'Routing row', (r, l) => {
            need(SEVERITIES.includes(r.severity), `${l} severity is invalid.`);
            need(typeof r.score === 'string' && /^\d+(-\d+)?$/.test(r.score.trim()), `${l} score must look like 50 or 30-49.`);
            text(r.action, `${l} action`, 100);
            text(r.recipient, `${l} recipient`, 100);
            need(['Yes', 'No'].includes(r.hold), `${l} hold must be Yes or No.`);
            bool(r.active, `${l} active`);
        });
        list(v.safeguards, 'Safeguard', (s, l) => { text(s.label, `${l} label`); bool(s.on, `${l} on`); });
        return { matrix: v.matrix.map((r) => ({ ...r, score: r.score.trim() })), safeguards: v.safeguards };
    },
    recommendation: (v) => {
        list(v.rules, 'Recommendation rule', (r, l) => {
            text(r.rule, `${l} rule`, 100);
            text(r.condition, `${l} condition`);
            text(r.stage, `${l} stage`, 60);
            text(r.result, `${l} result`, 60);
            need(['Active', 'Inactive'].includes(r.status), `${l} status must be Active or Inactive.`);
        });
        need(isObj(v.payValidation), 'payValidation is required.');
        const payValidation = {};
        for (const p of PAYEE_TYPES) {
            list(v.payValidation[p] ?? [], `${p} check`, (c, l) => { text(c.label, `${l} label`); bool(c.on, `${l} on`); });
            payValidation[p] = v.payValidation[p] ?? [];
        }
        return { rules: v.rules, payValidation };
    },
    stageConfig: (v) => {
        list(v.stages, 'Stage', (s, l) => {
            text(s.stage, `${l} name`, 60);
            text(s.owner, `${l} owner`, 60);
            text(s.tat, `${l} TAT`, 30);
            text(s.rule, `${l} rule`);
            bool(s.active, `${l} active`);
        });
        const names = v.stages.map((s) => s.stage.trim().toLowerCase());
        need(new Set(names).size === names.length, 'Two stages have the same name.');
        need(isObj(v.operatingModel), 'operatingModel is required.');
        return { stages: v.stages, operatingModel: v.operatingModel };
    },
    systemUpdate: (v) => switches(v, ['maintenanceApproval', 'autoSecurityPatches', 'maintenanceMode'], 'systemUpdate'),
    compliance: (v) => {
        need(RETENTION_OPTIONS.includes(v.retention), `retention must be one of: ${RETENTION_OPTIONS.join(', ')}.`);
        return { ...switches(v, ['auditLogin', 'inputLogging', 'configApproval'], 'compliance'), retention: v.retention };
    },
};

// ---- computed parts ----
const versionNumber = (v) => String(v).replace(/^v/i, '');
const newer = (a, b) => {
    const pa = versionNumber(a).split('.').map(Number);
    const pb = versionNumber(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
    return false;
};

export function systemInfo() {
    const deployments = listRecords('deployments');
    const current = deployments[0]?.version ?? versionNumber(env.appVersion);
    const latest = versionNumber(env.latestVersion);
    return {
        product: env.productName,
        environment: env.environmentName,
        current,
        latest: newer(latest, current) ? latest : current,
        latestReleasedAt: env.latestReleaseDate,
        deployments: deployments.map(({ id, version, at, by, notes }) => ({ id, version, at, by, notes })),
    };
}
export { newer };

/** Average minutes from intimation to settlement, from claims that report `tatMinutes`. */
function averageTatMinutes() {
    const tats = listClaims().map((c) => c.tatMinutes).filter((n) => typeof n === 'number' && n >= 0);
    return tats.length ? Math.round(tats.reduce((a, b) => a + b, 0) / tats.length) : 0;
}

function withComputed(key, value) {
    if (key === 'systemUpdate') return { ...value, ...systemInfo() };
    // Fraud Routing adds live trigger counts on top of these.
    if (key === 'routing') return { ...value, stats: { autoRouted: 0, autoCleared: 0 } };
    if (key === 'recommendation') return { ...value, stats: { avgTatMin: averageTatMinutes() } };
    return value;
}

/** GET /api/v1/settings -> { config, routing, recommendation, stageConfig, systemUpdate, compliance } */
router.get('/', (_req, res) => {
    res.json(Object.fromEntries(SETTING_KEYS.map((k) => [k, withComputed(k, getSetting(k))])));
});

router.get('/:key', (req, res) => {
    if (!SETTING_KEYS.includes(req.params.key)) throw notFound('Setting');
    res.json(withComputed(req.params.key, getSetting(req.params.key)));
});

/** PUT /api/v1/settings/:key -- the whole document. */
router.put('/:key', asyncHandler(async (req, res) => {
    const { key } = req.params;
    if (!SETTING_KEYS.includes(key)) throw notFound('Setting');
    need(isObj(req.body), 'Body must be an object.');
    need(Buffer.byteLength(JSON.stringify(req.body)) <= MAX_BYTES, 'This configuration is too large.');
    const stored = setSetting(key, SHAPES[key](req.body));
    res.json(withComputed(key, stored));
}));

export default router;
