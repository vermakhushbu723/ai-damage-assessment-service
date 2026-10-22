import { Router } from 'express';
import { db, nowIso, parseJson, transaction } from '../db/database.js';
import { asyncHandler, badRequest, notFound, conflict, normalizePhone } from '../utils/http.js';
import { authenticate, can, actorOf } from '../middleware/authenticate.js';
import { MODULES, HANDLER_ROLES, SURVEYOR_ROLES, REASSIGNMENT_REASONS, REASSIGNMENT_REMARKS, SURVEY_TYPES } from '../constants.js';
import { findClaimRow, setClaimFields, toClaim, completeStage, audit, addEvent, listEvents } from '../models/claimModel.js';
import { insertCommunication } from '../models/communicationModel.js';
import { directory, clearDirectoryCache } from '../services/adminClient.js';
import { syncClaim, flush } from '../services/sync.js';
import { dispatch } from '../services/notifier.js';
import { nextSequentialId } from '../utils/ids.js';
import { loadClaim } from './claims.js';

// Handler Allocation + Surveyor Assignment. The people are the users of
// Admin > Create Users (claim-handler / internal-surveyor / external-surveyor).

const router = Router();
router.use(authenticate);

const SURVEYOR_CAPACITY = 25;
const norm = (s) => String(s ?? '').trim().toLowerCase();
const matches = (q, ...fields) => !q || fields.some((f) => norm(f).includes(q));
const optionsOf = (rows, pick) => [...new Set(rows.map(pick).filter(Boolean))].sort();
const yearsSince = (date) => {
    const t = Date.parse(date ?? '');
    if (Number.isNaN(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t) / (365.25 * 86400_000)));
};

// ---------- handlers ----------

function handlerRow(u) {
    const s = u.handlerStats ?? {};
    const capacity = s.capacityLimit ?? 100;
    const open = s.inProgress ?? 0;
    const full = open >= capacity;
    return {
        id: u.id,
        name: u.name,
        employeeId: u.employeeId,
        roleName: u.roleName,
        email: u.email,
        contact: u.contact,
        city: u.city,
        state: u.state,
        pinCode: u.pinCode,
        team: u.branch ?? u.department ?? null,
        workshop: u.extra?.workshop ?? null,
        currentLoad: `${open}/${capacity}`,
        open,
        capacity,
        status: u.status !== 'Active' ? u.status : full ? 'Full' : 'Available',
        selectable: u.status === 'Active' && !full,
    };
}

/** GET /api/v1/handlers?search=&city=&state=&pin=&team=&availability= */
router.get('/handlers', can(MODULES.handler), asyncHandler(async (req, res) => {
    const all = (await directory(HANDLER_ROLES)).map(handlerRow);
    const q = norm(req.query.search);
    const f = (k) => (req.query[k] && req.query[k] !== 'all' ? String(req.query[k]) : null);
    const rows = all.filter((h) => matches(q, h.name, h.employeeId, h.email, h.contact)
        && (!f('city') || h.city === f('city'))
        && (!f('state') || h.state === f('state'))
        && (!f('pin') || h.pinCode === f('pin'))
        && (!f('team') || h.team === f('team'))
        && (!f('workshop') || h.workshop === f('workshop'))
        && (!f('availability') || h.status === f('availability')));
    res.json({
        rows,
        filters: {
            city: optionsOf(all, (h) => h.city),
            state: optionsOf(all, (h) => h.state),
            pin: optionsOf(all, (h) => h.pinCode),
            workshop: optionsOf(all, (h) => h.workshop),
            team: optionsOf(all, (h) => h.team),
            availability: optionsOf(all, (h) => h.status),
        },
    });
}));

/** GET /api/v1/claims/:id/handler -- current handler + history. */
router.get('/claims/:id/handler', can(MODULES.handler), asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    const history = listEvents(row.id, 'handler');
    let current = null;
    if (row.handler_id) {
        const person = (await directory(HANDLER_ROLES).catch(() => [])).find((u) => u.id === row.handler_id);
        const last = history.find((e) => e.data?.handlerId === row.handler_id);
        current = {
            ...(person ? handlerRow(person) : { id: row.handler_id, name: row.handler_name, status: 'Unknown' }),
            assignedOn: last?.at ?? null,
            method: last?.data?.method ?? null,
            assignedBy: last?.actorName ?? null,
        };
    }
    res.json({ current, history: history.map((e) => ({ action: e.action, detail: e.detail, by: e.actorName, at: e.at, ...e.data })) });
}));

/** POST /api/v1/claims/:id/handler { handlerId, reason, remark? } -- Allocate / Reassign Claim. */
router.post('/claims/:id/handler', can(MODULES.handler, 'edit'), asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    if (row.status !== 'Open') throw badRequest(row.status === 'Draft' ? 'Submit the intimation first.' : 'This claim is closed.');
    const { handlerId, reason, remark } = req.body ?? {};
    if (!handlerId) throw badRequest('Select the new handler.');
    const reassign = !!row.handler_id;
    if (reassign && !REASSIGNMENT_REASONS[reason]) throw badRequest('Select a reason for reassignment.');
    if (remark && !REASSIGNMENT_REMARKS[remark]) throw badRequest('Unknown remark.');
    if (handlerId === row.handler_id) throw conflict('This handler already has the claim.');
    clearDirectoryCache();
    const person = (await directory(HANDLER_ROLES)).find((u) => u.id === handlerId);
    if (!person) throw badRequest('Selected handler does not exist.');
    const h = handlerRow(person);
    if (!h.selectable) throw badRequest(`${h.name} cannot take claims now (${h.status}).`);

    const actor = actorOf(req);
    const method = reassign ? `Manual reassignment (${REASSIGNMENT_REASONS[reason]})` : 'Manual';
    transaction(() => {
        setClaimFields(row.id, { handler_id: h.id, handler_name: h.name });
        addEvent(row.id, {
            kind: 'handler',
            action: reassign ? 'Reassigned' : 'Allocated',
            detail: `${reassign ? `${row.handler_name} → ` : ''}${h.name}`,
            data: { handlerId: h.id, handlerName: h.name, previousId: row.handler_id, previousName: row.handler_name, method, reason: REASSIGNMENT_REASONS[reason] ?? null, remark: REASSIGNMENT_REMARKS[remark] ?? null },
            actor,
        });
        audit(row.id, reassign ? 'Handler reassigned' : 'Handler allocated', `${h.name}${reason ? ` · ${REASSIGNMENT_REASONS[reason]}` : ''}`, actor);
        completeStage(row.id, 'handler-allocation', actor);
    });
    await syncClaim(row.id);
    clearDirectoryCache();
    res.json(toClaim(findClaimRow(row.id)));
}));

// ---------- surveyors ----------

/** Open survey allocations per surveyor (this portal's own load). */
function surveyorLoads() {
    const rows = db.prepare(`SELECT sa.surveyor_id, COUNT(*) AS n FROM surveyor_assignments sa JOIN claims c ON c.id = sa.claim_id
                             WHERE sa.status = 'Assigned' AND c.status = 'Open' GROUP BY sa.surveyor_id`).all();
    return Object.fromEntries(rows.map((r) => [r.surveyor_id, r.n]));
}

function surveyorRow(u, loads) {
    const capacity = Number(u.extra?.capacity) || SURVEYOR_CAPACITY;
    const open = loads[u.id] ?? 0;
    const years = yearsSince(u.dateOfJoining);
    return {
        id: u.id,
        name: u.name,
        surveyorId: u.employeeId || u.userId,
        type: u.roleKey === 'external-surveyor' ? 'External Surveyor' : 'Internal Surveyor',
        typeKey: u.roleKey === 'external-surveyor' ? 'external' : 'internal',
        location: [u.city, u.state].filter(Boolean).join(', ') || '—',
        city: u.city,
        state: u.state,
        phone: u.contact,
        email: u.email,
        address: [u.city, u.state, u.pinCode].filter(Boolean).join(', ') || '—',
        currentLoad: `${open}/${capacity}`,
        open,
        capacity,
        experience: years === null ? '—' : `${String(years).padStart(2, '0')} Years`,
        rating: u.extra?.rating ? `${u.extra.rating}/5` : '—',
        availability: u.status !== 'Active' ? u.status : open >= capacity ? 'Full' : 'Available',
        selectable: u.status === 'Active' && open < capacity,
    };
}

/** GET /api/v1/surveyors?search=&type=all|internal|external&city=&state=&page=&pageSize= */
router.get('/surveyors', can(MODULES.surveyor), asyncHandler(async (req, res) => {
    const loads = surveyorLoads();
    const all = (await directory(SURVEYOR_ROLES)).map((u) => surveyorRow(u, loads));
    const q = norm(req.query.search);
    const f = (k) => (req.query[k] && req.query[k] !== 'all' ? String(req.query[k]) : null);
    const rows = all.filter((s) => matches(q, s.name, s.surveyorId, s.phone, s.email)
        && (!f('type') || s.typeKey === f('type'))
        && (!f('city') || s.city === f('city'))
        && (!f('state') || s.state === f('state')));
    const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 6));
    const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = Math.min(Math.max(1, Number(req.query.page) || 1), totalPages);
    res.json({
        rows: rows.slice((page - 1) * pageSize, page * pageSize),
        page,
        totalPages,
        total: rows.length,
        filters: { city: optionsOf(all, (s) => s.city), state: optionsOf(all, (s) => s.state) },
    });
}));

const toAssignment = (a) => (a ? {
    id: a.id, surveyType: a.survey_type, surveyorId: a.surveyor_id, surveyorName: a.surveyor_name, ...parseJson(a.data, {}),
    status: a.status, assignedBy: a.assigned_by, assignedAt: a.assigned_at, cancelledAt: a.cancelled_at,
} : null);

export function activeAssignment(claimId, type) {
    return toAssignment(db.prepare("SELECT * FROM surveyor_assignments WHERE claim_id = ? AND survey_type = ? AND status = 'Assigned' ORDER BY assigned_at DESC LIMIT 1").get(claimId, type));
}

function surveyorState(claimId) {
    return {
        assignments: Object.fromEntries(Object.keys(SURVEY_TYPES).map((t) => [t, activeAssignment(claimId, t)])),
        history: listEvents(claimId, 'surveyor').map((e) => ({ action: e.action, detail: e.detail, by: e.actorName, at: e.at, ...e.data })),
    };
}

router.get('/claims/:id/surveyors', can(MODULES.surveyor), (req, res) => {
    const row = loadClaim(req);
    res.json(surveyorState(row.id));
});

/**
 * POST /api/v1/claims/:id/surveyors { surveyType: spot|final, surveyorId }
 * "Asign Surveyor": replaces the current allocation of that survey type and
 * sends the survey link to the surveyor.
 */
router.post('/claims/:id/surveyors', can(MODULES.surveyor, 'edit'), asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    if (row.status !== 'Open') throw badRequest(row.status === 'Draft' ? 'Submit the intimation first.' : 'This claim is closed.');
    const { surveyType, surveyorId } = req.body ?? {};
    if (!SURVEY_TYPES[surveyType]) throw badRequest('surveyType must be spot or final.');
    if (!surveyorId) throw badRequest('Select a surveyor.');
    clearDirectoryCache();
    const person = (await directory(SURVEYOR_ROLES)).find((u) => u.id === surveyorId);
    if (!person) throw badRequest('Selected surveyor does not exist.');
    const s = surveyorRow(person, surveyorLoads());
    const current = activeAssignment(row.id, surveyType);
    if (current?.surveyorId === s.id) throw conflict(`${s.name} is already assigned for the ${SURVEY_TYPES[surveyType].toLowerCase()}.`);
    if (!s.selectable) throw badRequest(`${s.name} cannot take surveys now (${s.availability}).`);

    const actor = actorOf(req);
    const link = parseJson(row.link, {});
    const outcome = await dispatch({
        channel: 'SMS',
        to: normalizePhone(s.phone),
        subject: `${SURVEY_TYPES[surveyType]} assigned: ${row.claim_no}`,
        message: `${SURVEY_TYPES[surveyType]} assigned for claim ${row.claim_no} (${row.vehicle_no ?? ''}).${link.url ? ` Link: ${link.url}` : ''}`,
        claimNo: row.claim_no,
        reference: `survey-${surveyType}`,
    });
    const id = nextSequentialId('surveyor_assignments', 'SA');
    transaction(() => {
        if (current) {
            db.prepare("UPDATE surveyor_assignments SET status = 'Cancelled', cancelled_at = ? WHERE id = ?").run(nowIso(), current.id);
        }
        db.prepare(`INSERT INTO surveyor_assignments (id, claim_id, survey_type, surveyor_id, surveyor_name, data, status, assigned_by, assigned_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'Assigned', ?, ?)`)
            .run(id, row.id, surveyType, s.id, s.name, JSON.stringify({ surveyorCode: s.surveyorId, type: s.type, location: s.location, phone: s.phone, email: s.email }), actor.name, nowIso());
        addEvent(row.id, {
            kind: 'surveyor',
            action: current ? 'Reassigned' : 'Manually Assigned',
            detail: `${SURVEY_TYPES[surveyType]}: assigned to ${s.name} (${s.surveyorId}) by ${actor.name}`,
            data: { surveyType, surveyorId: s.id, surveyorName: s.name, previous: current?.surveyorName ?? null },
            actor,
        });
        insertCommunication(row.id, {
            direction: 'sent',
            type: 'Link Sent',
            tag: `${SURVEY_TYPES[surveyType]} Assignment`,
            reference: `Surveyor: ${s.name} (${s.surveyorId})`,
            description: `${SURVEY_TYPES[surveyType]} allocated to ${s.name}.`,
            subDescription: outcome.error ?? null,
            person: 'Ibima Assist',
            personMeta: `(${actor.name})`,
            channel: 'SMS',
            recipient: s.phone,
            status: outcome.status,
            createdBy: actor.id,
        });
        audit(row.id, 'Surveyor assigned', `${SURVEY_TYPES[surveyType]} · ${s.name}`, actor);
        completeStage(row.id, 'surveyor-assignment', actor);
    });
    await syncClaim(row.id);
    res.status(201).json({ ...surveyorState(row.id), claim: toClaim(findClaimRow(row.id)) });
}));

/** POST /api/v1/claims/:id/surveyors/:assignmentId/cancel */
router.post('/claims/:id/surveyors/:assignmentId/cancel', can(MODULES.surveyor, 'edit'), (req, res) => {
    const row = loadClaim(req);
    const a = db.prepare("SELECT * FROM surveyor_assignments WHERE id = ? AND claim_id = ? AND status = 'Assigned'").get(req.params.assignmentId, row.id);
    if (!a) throw notFound('Active assignment');
    const actor = actorOf(req);
    transaction(() => {
        db.prepare("UPDATE surveyor_assignments SET status = 'Cancelled', cancelled_at = ? WHERE id = ?").run(nowIso(), a.id);
        addEvent(row.id, { kind: 'surveyor', action: 'Assignment Cancelled', detail: `${SURVEY_TYPES[a.survey_type]}: ${a.surveyor_name} removed by ${actor.name}`, data: { surveyType: a.survey_type, surveyorId: a.surveyor_id }, actor });
        audit(row.id, 'Surveyor assignment cancelled', `${SURVEY_TYPES[a.survey_type]} · ${a.surveyor_name}`, actor);
    });
    flush().catch(() => {});
    res.json(surveyorState(row.id));
});

export default router;
