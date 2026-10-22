import { Router } from 'express';
import { db, nowIso, parseJson, transaction } from '../db/database.js';
import { asyncHandler, badRequest, notFound, conflict } from '../utils/http.js';
import { authenticate, can, actorOf } from '../middleware/authenticate.js';
import {
    MODULES, DAMAGE_TYPES, SEVERITIES, DAMAGE_ACTIONS, DAMAGE_STATUSES, TRACKED_FIELDS,
} from '../constants.js';
import { findClaimRow, toClaim, getDoc, putDoc, audit, completeStage, setClaimFields } from '../models/claimModel.js';
import { damageItems, aiEstimate, computeLiability, seedParts } from '../services/assessment.js';
import { aiConfigured, detect, assess, sendCorrection, retrainingStats } from '../services/aiClient.js';
import { readFile } from '../services/fileStore.js';
import { syncClaim } from '../services/sync.js';
import { currentDocuments } from './documents.js';
import { nextSequentialId } from '../utils/ids.js';
import { sendPdf } from '../utils/pdf.js';
import { fmtDateTime, inr, csvCell } from '../utils/format.js';
import { loadClaim } from './claims.js';

// AI ILA: the AI's part-by-part findings on the survey photos, reviewed and
// corrected by the CSM. Every change to an AI row is a correction that goes
// to the retraining queue when the assessment is approved.

const router = Router();
router.use(authenticate);

const VIEW = can(MODULES.aiIla);
const EDIT = can(MODULES.aiIla, 'edit');

const title = (s) => String(s ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const DAMAGE_MAP = { crack: 'Crack', dent: 'Dent', scratch: 'Scratch', glass_shatter: 'Broken Part', lamp_broken: 'Broken Part', tire_flat: 'Broken Part', unknown: 'Paint Damage' };
const VEHICLE_TYPE = { 'Private Car': 'car', 'Two Wheeler': 'two_wheeler', CV: 'commercial_vehicle' };

/** Bounding box (% of the photo) of a detection's mask polygon. */
function boxOf(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return null;
    const xs = polygon.map((p) => Number(p[0])).filter(Number.isFinite);
    const ys = polygon.map((p) => Number(p[1])).filter(Number.isFinite);
    if (!xs.length || !ys.length) return null;
    const scale = Math.max(...xs, ...ys) <= 1 ? 100 : null;
    if (!scale) return null; // pixel coordinates without the image size: no overlay
    const [x, y] = [Math.min(...xs) * scale, Math.min(...ys) * scale];
    return { x: +x.toFixed(1), y: +y.toFixed(1), w: +((Math.max(...xs) * scale) - x).toFixed(1), h: +((Math.max(...ys) * scale) - y).toFixed(1) };
}

const reviewOf = (claimId) => getDoc(claimId, 'aiReview', { status: 'not-run' });

// ---------- read model ----------

const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();

/** Weekly numbers of the Model Feedback Loop card (all claims). */
function feedbackStats() {
    const reviews = db.prepare("SELECT claim_id, data FROM claim_docs WHERE key = 'aiReview'").all()
        .map((r) => ({ claimId: r.claim_id, ...parseJson(r.data, {}) }))
        .filter((r) => r.decidedAt);
    const items = db.prepare('SELECT * FROM damage_items WHERE ai IS NOT NULL').all();
    const correctedRow = (r) => {
        const ai = parseJson(r.ai, {});
        return r.deleted_at || TRACKED_FIELDS.some((f) => ai[f] !== { damageType: r.damage_type, severity: r.severity, action: r.action, cost: r.cost, status: r.status }[f]);
    };
    const inWindow = (iso, from, to) => iso >= from && iso < to;
    const window = (from, to) => {
        const rs = reviews.filter((r) => inWindow(r.decidedAt, from, to));
        const ids = new Set(rs.map((r) => r.claimId));
        const its = items.filter((i) => ids.has(i.claim_id));
        const corrected = its.filter(correctedRow).length;
        const reviewSecs = rs.filter((r) => r.runAt).map((r) => (new Date(r.decidedAt) - new Date(r.runAt)) / 1000);
        const approved = rs.filter((r) => r.decision === 'Approved');
        return {
            corrections: items.filter((i) => inWindow(i.updated_at, from, to) && correctedRow(i)).length,
            accuracy: its.length ? (1 - corrected / its.length) * 100 : null,
            reviewSecs: reviewSecs.length ? reviewSecs.reduce((a, b) => a + b, 0) / reviewSecs.length : null,
            autoApprovals: approved.length && rs.length ? (approved.filter((r) => !r.corrections).length / rs.length) * 100 : null,
        };
    };
    const now = new Date(Date.now() + 60_000).toISOString();
    const cur = window(daysAgo(7), now);
    const prev = window(daysAgo(14), daysAgo(7));
    const delta = (a, b, unit = '%') => (a === null || b === null || !b ? null : `${a >= b ? '+' : ''}${(((a - b) / b) * 100).toFixed(0)}${unit}`);
    const mmss = (s) => (s === null ? '—' : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`);
    const dir = (a, b) => (a !== null && b !== null && a < b ? 'down' : 'up');
    return [
        { key: 'corrections', label: 'CORRECTIONS THIS WEEK', value: String(cur.corrections), delta: delta(cur.corrections, prev.corrections), direction: dir(cur.corrections, prev.corrections) },
        { key: 'accuracy', label: 'MODEL ACCURACY', value: cur.accuracy === null ? '—' : `${cur.accuracy.toFixed(1)}%`, delta: delta(cur.accuracy, prev.accuracy), direction: dir(cur.accuracy, prev.accuracy) },
        { key: 'review-time', label: 'AVG REVIEW TIME', value: mmss(cur.reviewSecs), delta: delta(cur.reviewSecs, prev.reviewSecs), direction: dir(cur.reviewSecs, prev.reviewSecs) },
        { key: 'auto-approvals', label: 'AUTO-APPROVALS', value: cur.autoApprovals === null ? '—' : `${Math.round(cur.autoApprovals)}%`, delta: delta(cur.autoApprovals, prev.autoApprovals), direction: dir(cur.autoApprovals, prev.autoApprovals) },
    ];
}

async function ilaState(row) {
    const claim = toClaim(row);
    const items = damageItems(row.id);
    const review = reviewOf(row.id);
    const photos = currentDocuments(row.id).filter((d) => d.type === 'vehicle-photos');
    const photoSizeMb = photos.reduce((s, p) => s + p.size, 0) / (1024 * 1024);
    const corrections = items.filter((i) => i.corrected).length
        + db.prepare('SELECT COUNT(*) AS n FROM damage_items WHERE claim_id = ? AND deleted_at IS NOT NULL AND ai IS NOT NULL').get(row.id).n;

    // Insights from what is really known about this claim.
    const withConf = items.filter((i) => i.confidence !== null && i.confidence !== undefined);
    const confidence = withConf.length ? Math.round(withConf.reduce((s, i) => s + i.confidence, 0) / withConf.length) : null;
    const weight = { Severe: 100, Moderate: 60, Minor: 25 };
    const damageScore = items.length ? Math.min(100, Math.round(items.reduce((s, i) => s + (weight[i.severity] ?? 0), 0) / Math.max(4, items.length))) : null;
    const hashes = photos.map((p) => p.sha256);
    const duplicates = hashes.length - new Set(hashes).size;
    const previous = row.vehicle_no
        ? db.prepare("SELECT claim_no FROM claims WHERE vehicle_no = ? AND id <> ? AND status <> 'Draft'").all(row.vehicle_no, row.id).map((r) => r.claim_no)
        : [];
    const replace = items.filter((i) => i.action === 'Replace' && i.status !== 'Rejected').length;
    const repair = items.filter((i) => i.action === 'Repair' && i.status !== 'Rejected').length;
    const minDays = items.length ? Math.max(1, Math.ceil(repair / 2) + replace) : 0;

    // Initial loss assessment card: same math as Handler ILA.
    const liability = computeLiability({ parts: seedParts(items) });
    const total = aiEstimate(items);
    const i = claim.intimation;
    const incident = Date.parse(i.dateOfIncident ?? '');
    const policyStart = Date.parse(i.policyStartDate ?? '');
    const policyEnd = Date.parse(i.policyEndDate ?? '');
    const withinPolicy = Number.isNaN(incident) || Number.isNaN(policyEnd) ? null
        : incident <= policyEnd && (Number.isNaN(policyStart) || incident >= policyStart);
    const fraudFlags = [duplicates ? `${duplicates} duplicate image(s)` : null, previous.length ? `previous claim ${previous[0]}` : null].filter(Boolean);
    const retraining = await retrainingStats();

    const ran = review.status === 'done';
    const steps = [
        { key: 'survey-images', step: 'STEP 1', title: 'Survey Images', detail: `${photos.length} Images - ${photoSizeMb.toFixed(1)}MB`, state: photos.length ? 'done' : 'active' },
        { key: 'ai-detection', step: 'STEP 2', title: 'AI Detection', detail: ran ? `${items.filter((x) => x.source === 'ai').length} Damages - ${((review.processingMs ?? 0) / 1000).toFixed(1)}s` : aiConfigured() ? 'Not run yet' : 'AI not connected', state: ran ? 'done' : photos.length ? 'active' : 'pending' },
        { key: 'ila-report', step: 'STEP 3', title: 'ILA Report', detail: review.reportGeneratedAt ? 'Report Generated' : items.length ? 'Draft Ready' : 'Pending', state: review.reportGeneratedAt ? 'done' : items.length ? 'active' : 'pending' },
        { key: 'csm-review', step: 'STEP 4', title: 'CSM Review', detail: `${corrections} correction${corrections === 1 ? '' : 's'}`, state: review.decision ? 'done' : items.length ? 'active' : 'pending' },
        { key: 'feedback', step: 'STEP 5', title: 'Feedback', detail: review.feedbackSent ? `${review.feedbackSent} Sent` : review.decision ? 'Nothing To Send' : 'Queued', state: review.decision ? 'done' : 'pending' },
        { key: 'ai-retraining', step: 'STEP 6', title: 'AI Retraining', detail: retraining ? `${retraining.pending_corrections}/${retraining.volume_threshold} Queued` : 'Not Connected', state: retraining?.threshold_reached ? 'active' : 'pending' },
    ];

    return {
        claim,
        ai: {
            configured: aiConfigured(),
            status: review.status ?? 'not-run',
            error: review.error ?? null,
            model: review.model ?? null,
            placeholderModel: !!review.placeholderModel,
            runAt: review.runAt ?? null,
            processingMs: review.processingMs ?? null,
        },
        images: photos.map((p) => ({ id: p.id, name: p.name, url: p.url, uploadedAt: p.uploadedAt, flagged: items.some((x) => x.documentId === p.id) })),
        rows: items,
        corrections,
        insights: {
            donuts: [
                { key: 'confidence', label: 'AI Confidence', value: confidence ?? 0, display: confidence === null ? '—' : `${confidence}%` },
                { key: 'damage-score', label: 'Damage Score', value: damageScore ?? 0, display: damageScore === null ? '—' : `${damageScore}/100` },
                { key: 'fraud', label: 'Fraud Flags', value: Math.min(100, fraudFlags.length * 50), display: String(fraudFlags.length).padStart(2, '0') },
                { key: 'images', label: 'Images Reviewed', value: photos.length ? Math.round((photos.filter((p) => items.some((x) => x.documentId === p.id)).length / photos.length) * 100) : 0, display: `${photos.length}` },
            ],
            rows: [
                { key: 'duplicate', label: 'Duplicate Images', value: `${duplicates} Of ${photos.length}`, tone: duplicates ? 'text-red-500' : null },
                { key: 'previous-match', label: 'Previous Claim Match', value: previous.length ? previous.slice(0, 2).join(', ') : 'No Matches', tone: previous.length ? 'text-red-500' : 'text-emerald-600' },
                { key: 'processing-time', label: 'AI Processing Time', value: review.processingMs ? `${(review.processingMs / 1000).toFixed(1)}s` : '—' },
                { key: 'repair-duration', label: 'Est Repair Duration', value: items.length ? `${minDays}-${minDays + 2} Days` : '—' },
            ],
        },
        summary: {
            badge: withinPolicy === null ? 'Policy Dates Missing' : withinPolicy ? 'Within Policy' : 'Outside Policy Period',
            total,
            vehicle: [i.make, i.model].filter(Boolean).join(' ') + (i.manufacturingYear ? ` (${new Date(i.manufacturingYear).getFullYear()})` : '') || claim.vehicleNo || '—',
            meta: `${items.filter((x) => x.status !== 'Rejected').length} damaged parts · ${claim.vehicleNo ?? ''}`,
            costs: [
                { key: 'repair', label: 'Repair Cost', value: items.filter((x) => x.action === 'Repair' && x.status !== 'Rejected').reduce((s, x) => s + x.cost, 0) },
                { key: 'replacement', label: 'Replacement Cost', value: items.filter((x) => x.action === 'Replace' && x.status !== 'Rejected').reduce((s, x) => s + x.cost, 0) },
                { key: 'labour', label: 'Labour Cost', value: liability.labour.removeRefit + liability.labour.repair },
                { key: 'paint', label: 'Paint Charges', value: liability.labour.paint },
            ],
            recommendation: withinPolicy === false
                ? { title: 'AI Recommendation: Review', detail: 'Incident date is outside the policy period', ok: false }
                : fraudFlags.length
                    ? { title: 'AI Recommendation: Review', detail: `Check ${fraudFlags.join(' and ')}`, ok: false }
                    : { title: 'AI Recommendation: Approve', detail: items.length ? 'Consistent with policy period, no duplicate or prior match' : 'Waiting for damage findings', ok: !!items.length },
            fraud: { title: 'Fraud Analysis', detail: fraudFlags.length ? `Flags: ${fraudFlags.join(', ')}` : 'Low Risk - No Duplicate/Prior Match' },
        },
        review: {
            note: review.note ?? '',
            noteSavedAt: review.noteSavedAt ?? null,
            decision: review.decision ?? null,
            decidedBy: review.decidedBy ?? null,
            decidedAt: review.decidedAt ?? null,
            reportGeneratedAt: review.reportGeneratedAt ?? null,
            feedbackSent: review.feedbackSent ?? 0,
        },
        feedback: {
            steps,
            stats: feedbackStats(),
            pipeline: aiConfigured()
                ? { label: retraining ? 'Pipeline healthy' : 'AI service unreachable', healthy: !!retraining, version: review.model ?? 'model —' }
                : { label: 'AI not connected', healthy: false, version: 'AI_SERVICE_URL not set' },
        },
    };
}

router.get('/claims/:id/ai-ila', VIEW, asyncHandler(async (req, res) => res.json(await ilaState(loadClaim(req)))));

/**
 * POST /api/v1/claims/:id/ai-ila/run -- sends every vehicle photo of the DMS
 * to the AI service (detect + assess) and replaces the AI rows.
 */
router.post('/claims/:id/ai-ila/run', EDIT, asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    if (row.status === 'Draft') throw badRequest('Submit the intimation first.');
    if (!aiConfigured()) throw badRequest('AI service is not connected. Add the damaged parts with "Add Damages".');
    const review = reviewOf(row.id);
    if (review.decision === 'Approved') throw conflict('The AI assessment is already approved.');
    const photos = db.prepare("SELECT * FROM documents WHERE claim_id = ? AND doc_type = 'vehicle-photos' AND replaced_at IS NULL ORDER BY uploaded_at").all(row.id);
    if (!photos.length) throw badRequest('Upload vehicle photos in Documents DMS first.');

    const i = parseJson(row.intimation, {});
    const details = getDoc(row.id, 'details')?.values ?? {};
    const year = Number(details.yearOfManufacture) || (i.manufacturingYear ? new Date(i.manufacturingYear).getFullYear() : new Date().getFullYear());
    const vehicle = { make: details.make || i.make || 'Unknown', model: details.model || i.model || 'Unknown', year, region: 'default' };
    const vehicleType = VEHICLE_TYPE[i.product] ?? 'car';

    const started = Date.now();
    const found = [];
    let model = null;
    let placeholder = false;
    try {
        for (const p of photos) {
            const buf = readFile(row.id, p.stored_name);
            if (!buf) continue;
            const d = await detect(buf, p.mime, p.file_name, vehicleType);
            model = d.model_checkpoint ?? model;
            placeholder = placeholder || !!d.is_placeholder_model;
            if (!d.detections?.length) continue;
            const a = await assess(vehicle, d.detections, d.photo_id);
            d.detections.forEach((det, idx) => {
                const line = a.line_items?.[idx] ?? {};
                found.push({ photo: p, photoId: d.photo_id, det, line });
            });
        }
    } catch (err) {
        putDoc(row.id, 'aiReview', { ...review, status: 'failed', error: err.detail ?? err.message }, actorOf(req));
        throw err;
    }

    const actor = actorOf(req);
    const now = nowIso();
    transaction(() => {
        db.prepare("UPDATE damage_items SET deleted_at = ? WHERE claim_id = ? AND source = 'ai' AND deleted_at IS NULL").run(now, row.id);
        for (const f of found) {
            const values = {
                part: title(f.det.part || f.line.part || 'Unknown Part'),
                damageType: DAMAGE_MAP[f.det.damage_type] ?? 'Dent',
                severity: title(f.line.severity || 'moderate'),
                action: title(f.line.action || 'repair'),
                cost: Math.round(Number(f.line.line_total) || 0),
                status: 'Pending',
            };
            if (!SEVERITIES.includes(values.severity)) values.severity = 'Moderate';
            if (!DAMAGE_ACTIONS.includes(values.action)) values.action = 'Repair';
            db.prepare(`INSERT INTO damage_items (id, claim_id, part, damage_type, severity, action, cost, confidence, status, source, ai, document_id, box, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, ?, ?)`)
                .run(nextSequentialId('damage_items', 'DMG'), row.id, values.part, values.damageType, values.severity, values.action, values.cost,
                    Math.round((Number(f.det.confidence) || 0) * 100), values.status,
                    JSON.stringify({ ...values, photoId: f.photoId, detection: f.det }), f.photo.id, JSON.stringify(boxOf(f.det.mask_polygon)), now, now);
        }
        putDoc(row.id, 'aiReview', {
            ...review, status: 'done', error: null, model, placeholderModel: placeholder, runAt: now, processingMs: Date.now() - started,
        }, actor);
        const total = aiEstimate(damageItems(row.id));
        setClaimFields(row.id, { amount: total });
        audit(row.id, 'AI assessment run', `${found.length} damage(s) on ${photos.length} photo(s) · ₹${inr(total)}`, actor);
    });
    syncClaim(row.id).catch(() => {});
    res.json(await ilaState(findClaimRow(row.id)));
}));

// ---------- reviewer edits ----------

const ITEM_FIELDS = {
    damageType: (v) => DAMAGE_TYPES.includes(v),
    severity: (v) => SEVERITIES.includes(v),
    action: (v) => DAMAGE_ACTIONS.includes(v),
    status: (v) => DAMAGE_STATUSES.includes(v),
    cost: (v) => Number.isInteger(v) && v >= 0 && v <= 100_000_000,
    part: (v) => typeof v === 'string' && v.trim().length >= 2 && v.length <= 80,
    box: (v) => v === null || (v && ['x', 'y', 'w', 'h'].every((k) => Number.isFinite(v[k]) && v[k] >= 0 && v[k] <= 100)),
};
const COLUMN = { damageType: 'damage_type', severity: 'severity', action: 'action', status: 'status', cost: 'cost', part: 'part', box: 'box' };

function editable(req) {
    const row = loadClaim(req);
    if (reviewOf(row.id).decision === 'Approved') throw conflict('The AI assessment is approved; it can no longer be changed.');
    return row;
}

function findItem(claimId, itemId) {
    const it = db.prepare('SELECT * FROM damage_items WHERE id = ? AND claim_id = ? AND deleted_at IS NULL').get(itemId, claimId);
    if (!it) throw notFound('Damage row');
    return it;
}

const afterEdit = async (req, row, action, detail) => {
    audit(row.id, action, detail, actorOf(req));
    setClaimFields(row.id, { amount: aiEstimate(damageItems(row.id)) });
    return ilaState(findClaimRow(row.id));
};

/** PATCH /api/v1/claims/:id/ai-ila/items/:itemId { damageType?, severity?, action?, cost?, status?, part?, box? } */
router.patch('/claims/:id/ai-ila/items/:itemId', EDIT, asyncHandler(async (req, res) => {
    const row = editable(req);
    const it = findItem(row.id, req.params.itemId);
    const sets = [];
    const vals = [];
    for (const [k, ok] of Object.entries(ITEM_FIELDS)) {
        if (!(k in (req.body ?? {}))) continue;
        let v = req.body[k];
        if (k === 'part' && typeof v === 'string') v = v.trim();
        if (!ok(v)) throw badRequest(`Invalid ${k}.`);
        sets.push(`${COLUMN[k]} = ?`);
        vals.push(k === 'box' ? JSON.stringify(v) : v);
    }
    if (!sets.length) throw badRequest('Nothing to change.');
    db.prepare(`UPDATE damage_items SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), it.id);
    res.json(await afterEdit(req, row, 'Damage row edited', `${it.part}: ${Object.keys(req.body).filter((k) => ITEM_FIELDS[k]).join(', ')}`));
}));

/** POST /api/v1/claims/:id/ai-ila/items { part, damageType, severity, action, cost, documentId?, box? } -- "Add Damages". */
router.post('/claims/:id/ai-ila/items', EDIT, asyncHandler(async (req, res) => {
    const row = editable(req);
    const b = req.body ?? {};
    const v = { part: String(b.part ?? '').trim(), damageType: b.damageType, severity: b.severity, action: b.action, cost: Number(b.cost) || 0, box: b.box ?? null };
    for (const k of ['part', 'damageType', 'severity', 'action', 'cost', 'box']) if (!ITEM_FIELDS[k](v[k])) throw badRequest(`Invalid ${k}.`);
    const doc = b.documentId ? db.prepare("SELECT id FROM documents WHERE id = ? AND claim_id = ? AND doc_type = 'vehicle-photos'").get(b.documentId, row.id) : null;
    const now = nowIso();
    db.prepare(`INSERT INTO damage_items (id, claim_id, part, damage_type, severity, action, cost, confidence, status, source, ai, document_id, box, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'In Review', 'reviewer', NULL, ?, ?, ?, ?)`)
        .run(nextSequentialId('damage_items', 'DMG'), row.id, v.part, v.damageType, v.severity, v.action, v.cost, doc?.id ?? null, JSON.stringify(v.box), now, now);
    res.status(201).json(await afterEdit(req, row, 'Damage added', `${v.part} · ${v.damageType} · ₹${inr(v.cost)}`));
}));

/** DELETE /api/v1/claims/:id/ai-ila/items/:itemId */
router.delete('/claims/:id/ai-ila/items/:itemId', EDIT, asyncHandler(async (req, res) => {
    const row = editable(req);
    const it = findItem(row.id, req.params.itemId);
    db.prepare('UPDATE damage_items SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), it.id);
    res.json(await afterEdit(req, row, 'Damage deleted', it.part));
}));

/** POST /api/v1/claims/:id/ai-ila/items/merge { ids: [a, b, ...] } -- keeps the first row, adds up the cost, takes the worst severity. */
router.post('/claims/:id/ai-ila/items/merge', EDIT, asyncHandler(async (req, res) => {
    const row = editable(req);
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids)] : [];
    if (ids.length < 2) throw badRequest('Select at least two damages to merge.');
    const items = ids.map((id) => findItem(row.id, id));
    const [keep, ...rest] = items;
    const order = ['Severe', 'Moderate', 'Minor'];
    const severity = order.find((s) => items.some((i) => i.severity === s)) ?? keep.severity;
    const action = items.some((i) => i.action === 'Replace') ? 'Replace' : 'Repair';
    const cost = items.reduce((s, i) => s + i.cost, 0);
    const now = nowIso();
    transaction(() => {
        db.prepare('UPDATE damage_items SET severity = ?, action = ?, cost = ?, updated_at = ? WHERE id = ?').run(severity, action, cost, now, keep.id);
        rest.forEach((i) => db.prepare('UPDATE damage_items SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, i.id));
    });
    res.json(await afterEdit(req, row, 'Damages merged', `${items.map((i) => i.part).join(' + ')} → ${keep.part}`));
}));

/** POST /api/v1/claims/:id/ai-ila/approve-all -- every row not rejected -> Approval. */
router.post('/claims/:id/ai-ila/approve-all', EDIT, asyncHandler(async (req, res) => {
    const row = editable(req);
    const n = db.prepare("UPDATE damage_items SET status = 'Approval', updated_at = ? WHERE claim_id = ? AND deleted_at IS NULL AND status <> 'Rejected' AND status <> 'Approval'")
        .run(nowIso(), row.id).changes;
    res.json(await afterEdit(req, row, 'All damages approved', `${n} row(s)`));
}));

/** PUT /api/v1/claims/:id/ai-ila/note { note } -- Review Notes "Save". */
router.put('/claims/:id/ai-ila/note', EDIT, asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    const note = String(req.body?.note ?? '').slice(0, 2000);
    putDoc(row.id, 'aiReview', { ...reviewOf(row.id), note, noteSavedAt: nowIso() }, actorOf(req));
    res.json(await ilaState(row));
}));

/**
 * POST /api/v1/claims/:id/ai-ila/decision { decision: 'Approved' | 'Rejected' }
 * Approve AI: the reviewed rows become the claim's assessment (AI ILA stage
 * done) and every correction goes to the retraining queue. Reject AI: the
 * assessment stays open for rework.
 */
router.post('/claims/:id/ai-ila/decision', EDIT, asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    const decision = req.body?.decision;
    if (!['Approved', 'Rejected'].includes(decision)) throw badRequest("decision must be 'Approved' or 'Rejected'.");
    const review = reviewOf(row.id);
    if (review.decision === 'Approved') throw conflict('The AI assessment is already approved.');
    const items = damageItems(row.id);
    if (decision === 'Approved' && !items.filter((i) => i.status !== 'Rejected').length) throw badRequest('There are no damages to approve. Add damages first.');
    const actor = actorOf(req);

    let feedbackSent = 0;
    if (decision === 'Approved' && aiConfigured()) {
        const i = parseJson(row.intimation, {});
        for (const it of items.filter((x) => x.corrected && x.ai?.photoId)) {
            try {
                await sendCorrection({
                    claim_id: row.claim_no,
                    photo_id: it.ai.photoId,
                    vehicle_type: VEHICLE_TYPE[i.product] ?? 'car',
                    ai_output: { part: it.ai.part, damage_type: it.ai.damageType, severity: it.ai.severity, action: it.ai.action, cost: it.ai.cost },
                    corrected_output: { part: it.part, damage_type: it.damageType, severity: it.severity, action: it.action, cost: it.cost, status: it.status },
                    reviewer_id: actor.id ?? 'unknown',
                    reason: review.note || null,
                });
                feedbackSent += 1;
            } catch {
                /* retraining queue unreachable: the decision still stands */
            }
        }
    }
    const corrections = items.filter((x) => x.corrected).length;
    transaction(() => {
        putDoc(row.id, 'aiReview', {
            ...review, decision, decidedBy: actor.name, decidedAt: nowIso(), corrections, feedbackSent,
            runAt: review.runAt ?? review.runAt ?? null,
        }, actor);
        if (decision === 'Approved') {
            setClaimFields(row.id, { amount: aiEstimate(items) });
            completeStage(row.id, 'ai-ila', actor);
        }
        audit(row.id, decision === 'Approved' ? 'AI assessment approved' : 'AI assessment rejected', `${corrections} correction(s)${feedbackSent ? `, ${feedbackSent} sent to retraining` : ''}`, actor);
    });
    syncClaim(row.id).catch(() => {});
    res.json(await ilaState(findClaimRow(row.id)));
}));

/** POST /api/v1/claims/:id/ai-ila/report -- "Generate ILA Report". */
router.post('/claims/:id/ai-ila/report', EDIT, asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    if (!damageItems(row.id).length) throw badRequest('No damages to report yet.');
    putDoc(row.id, 'aiReview', { ...reviewOf(row.id), reportGeneratedAt: nowIso() }, actorOf(req));
    audit(row.id, 'ILA report generated', null, actorOf(req));
    res.json(await ilaState(findClaimRow(row.id)));
}));

/** GET /api/v1/claims/:id/ai-ila/report.pdf -- "Download Draft (PDF)". */
router.get('/claims/:id/ai-ila/report.pdf', VIEW, asyncHandler(async (req, res) => {
    const row = loadClaim(req);
    const s = await ilaState(row);
    const c = s.claim;
    sendPdf(res, `ILA-${c.claimNo}.pdf`, [
        { text: 'IBIMA ASSIST - INITIAL LOSS ASSESSMENT (DRAFT)', size: 14, bold: true, align: 'center' },
        { text: `Generated ${fmtDateTime(nowIso())}`, size: 9, align: 'center', gap: 2 },
        { rule: true, gap: 8 },
        { cols: ['Claim No', c.claimNo] }, { cols: ['Assist Claim ID', c.id] }, { cols: ['Insured', c.insuredName ?? '-'] },
        { cols: ['Vehicle', `${s.summary.vehicle} · ${c.vehicleNo ?? ''}`] }, { cols: ['Policy No', c.policyNo ?? '-'] },
        { cols: ['Policy check', s.summary.badge] },
        { rule: true, gap: 4 },
        { text: 'Detected damages', bold: true, size: 11, gap: 4 },
        ...s.rows.map((r) => ({ cols: [`${r.key}. ${r.part} - ${r.damageType}, ${r.severity}, ${r.action} (${r.status})`, `Rs. ${inr(r.cost)}`] })),
        { rule: true, gap: 4 },
        ...s.summary.costs.map((x) => ({ cols: [x.label, `Rs. ${inr(x.value)}`] })),
        { cols: ['AI ILA estimate', `Rs. ${inr(s.summary.total)}`], bold: true },
        { text: `${s.summary.recommendation.title} - ${s.summary.recommendation.detail}`, gap: 10 },
        { text: `${s.summary.fraud.title}: ${s.summary.fraud.detail}` },
        ...(s.review.note ? [{ text: `Review notes: ${s.review.note}`, gap: 6 }] : []),
        { text: `Model: ${s.ai.model ?? 'not run'} · Corrections: ${s.corrections}`, size: 8, gap: 12 },
        { text: 'Draft generated by IBima Assist. Not a settlement offer.', size: 8 },
    ]);
}));

/** GET /api/v1/claims/:id/ai-ila/export.csv -- "Export CSV". */
router.get('/claims/:id/ai-ila/export.csv', VIEW, (req, res) => {
    const row = loadClaim(req);
    const head = ['Vehicle Part', 'Damage Type', 'Severity', 'Action', 'Est. Cost', 'AI Confidence', 'Status', 'Source', 'Corrected'];
    const lines = damageItems(row.id).map((r) => [r.part, r.damageType, r.severity, r.action, r.cost, r.confidence === null ? '' : `${r.confidence}%`, r.status, r.source, r.corrected ? 'Yes' : 'No'].map(csvCell).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="AI-ILA-${row.claim_no}.csv"`);
    res.end([head.join(','), ...lines].join('\n'));
});

export default router;
