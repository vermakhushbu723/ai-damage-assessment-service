import { Router } from 'express';
import { db, nowIso, parseJson, transaction } from '../db/database.js';
import { asyncHandler, badRequest, notFound, conflict } from '../utils/http.js';
import { authenticate, can, actorOf } from '../middleware/authenticate.js';
import {
    MODULES, MATERIALS, DAMAGE_ACTIONS, ALLOWED, DEFAULT_HSN, PAYMENT_TYPES, PAYMENT_MODES, PAYMENT_PRIORITIES, PAYEE_TYPES,
    PAYMENT_FOR, APPROVER_ROLES, SURVEYOR_ROLES, PAYBILL_LINES, PAYBILL_GST,
} from '../constants.js';
import { findClaimRow, toClaim, getDoc, putDoc, audit, completeStage, setClaimFields } from '../models/claimModel.js';
import { damageItems, aiEstimate, liabilityDoc, computeLiability } from '../services/assessment.js';
import { directory } from '../services/adminClient.js';
import { syncClaim } from '../services/sync.js';
import { currentDocuments } from './documents.js';
import { activeAssignment } from './assignment.js';
import { sendPdf } from '../utils/pdf.js';
import { fmtDate, fmtDateTime, inr, inr2 } from '../utils/format.js';
import { loadClaim } from './claims.js';

// Handler ILA (liability), Payment Recommendation and Survey Paybill.

const router = Router();
router.use(authenticate);

const openClaim = (req) => {
    const row = loadClaim(req);
    if (row.status === 'Draft') throw badRequest('Submit the intimation first.');
    return row;
};

// ======================= Handler ILA + FLA (liability) =======================
// Two documents with the same shape: 'liability' = HANDLER ILA (the handler's
// assessment), 'fla' = FLA (final loss assessment, seeded from the Handler ILA).
// Submitting the FLA completes the journey's FLA step.

const KINDS = {
    liability: { module: MODULES.handlerIla, title: 'HANDLER ILA - INTELLIGENT LIABILITY ASSESSMENT', label: 'Handler ILA', file: 'Handler-ILA' },
    fla: { module: MODULES.fla, title: 'FLA - FINAL LOSS ASSESSMENT', label: 'FLA', file: 'FLA' },
};
const KIND_PATH = '/claims/:id/:kind(liability|fla)';

/** Role check on the module of the requested kind. */
const canKind = (action = 'view') => (req, res, next) => can(KINDS[req.params.kind].module, action)(req, res, next);

function liabilityState(row, kind) {
    const doc = liabilityDoc(row.id, kind);
    const computed = computeLiability(doc);
    return {
        kind,
        status: doc.status ?? 'Draft',
        seeded: !!doc.seeded,
        seededFrom: doc.seededFrom ?? null,
        submittedAt: doc.submittedAt ?? null,
        submittedBy: doc.submittedBy ?? null,
        reportGeneratedAt: doc.reportGeneratedAt ?? null,
        ...computed,
        options: { materials: MATERIALS, actions: DAMAGE_ACTIONS, allowed: ALLOWED },
    };
}

/** Saved copy of the liability (the seeded one is saved on the first change). */
function editableLiability(row, kind) {
    const doc = liabilityDoc(row.id, kind);
    if (doc.status === 'Submitted') throw conflict(`The ${KINDS[kind].label} report is submitted; it can no longer be changed.`);
    const { seeded: _s, seededFrom: _f, updatedAt: _u, updatedBy: _b, ...rest } = doc;
    return rest;
}

function checkPart(p, partial = false) {
    const out = {};
    if (!partial || 'part' in p) {
        const name = String(p.part ?? '').trim();
        if (name.length < 2 || name.length > 80) throw badRequest('Part name must be 2-80 characters.');
        out.part = name;
    }
    if (!partial || 'material' in p) {
        if (!MATERIALS.includes(p.material)) throw badRequest(`Material must be one of: ${MATERIALS.join(', ')}.`);
        out.material = p.material;
    }
    if (!partial || 'action' in p) {
        if (!DAMAGE_ACTIONS.includes(p.action)) throw badRequest('Repair/Replace must be Repair or Replace.');
        out.action = p.action;
    }
    if (!partial || 'allowed' in p) {
        if (!ALLOWED.includes(p.allowed)) throw badRequest('Choose Allowed or Disallowed.');
        out.allowed = p.allowed;
    }
    if ('remarks' in p) out.remarks = String(p.remarks ?? '').trim().slice(0, 200);
    if ('partPrice' in p) {
        const n = Number(p.partPrice);
        if (!Number.isFinite(n) || n < 0 || n > 100_000_000) throw badRequest('Part price must be a positive amount.');
        out.partPrice = Math.round(n);
    }
    if ('hsnCode' in p) {
        if (!/^\d{4,8}$/.test(String(p.hsnCode))) throw badRequest('HSN/SAC code must be 4-8 digits.');
        out.hsnCode = String(p.hsnCode);
    }
    return out;
}

router.get(KIND_PATH, canKind(), (req, res) => res.json(liabilityState(openClaim(req), req.params.kind)));

/** POST /api/v1/claims/:id/(liability|fla)/parts { part, material, action, allowed, remarks?, partPrice? } -- "Add Part". */
router.post(`${KIND_PATH}/parts`, canKind('edit'), (req, res) => {
    const { kind } = req.params;
    const row = openClaim(req);
    const doc = editableLiability(row, kind);
    const part = { remarks: '', partPrice: 0, hsnCode: DEFAULT_HSN, ...checkPart(req.body ?? {}) };
    const n = (doc.parts ?? []).reduce((m, p) => Math.max(m, Number(String(p.id).split('-')[1]) || 0), 0) + 1;
    doc.parts = [...(doc.parts ?? []), { id: `LP-${n}`, ...part }];
    putDoc(row.id, kind, { ...doc, status: 'Draft' }, actorOf(req));
    audit(row.id, `${KINDS[kind].label} part added`, `${part.part} (${part.action})`, actorOf(req));
    res.status(201).json(liabilityState(row, kind));
});

/** PATCH /api/v1/claims/:id/(liability|fla)/parts/:partId -- edit a row (material, action, allowed, remarks, price). */
router.patch(`${KIND_PATH}/parts/:partId`, canKind('edit'), (req, res) => {
    const { kind } = req.params;
    const row = openClaim(req);
    const doc = editableLiability(row, kind);
    const idx = (doc.parts ?? []).findIndex((p) => p.id === req.params.partId);
    if (idx < 0) throw notFound('Part');
    doc.parts[idx] = { ...doc.parts[idx], ...checkPart(req.body ?? {}, true) };
    putDoc(row.id, kind, { ...doc, status: 'Draft' }, actorOf(req));
    res.json(liabilityState(row, kind));
});

/** PUT /api/v1/claims/:id/(liability|fla)/charges { towing?, voluntaryExcess?, salvage?, other?, compulsoryExcess? } */
router.put(`${KIND_PATH}/charges`, canKind('edit'), (req, res) => {
    const { kind } = req.params;
    const row = openClaim(req);
    const doc = editableLiability(row, kind);
    const charges = { ...(doc.charges ?? {}) };
    for (const k of ['towing', 'voluntaryExcess', 'salvage', 'other', 'compulsoryExcess']) {
        if (!(k in (req.body ?? {}))) continue;
        const n = Number(req.body[k]);
        if (!Number.isFinite(n) || n < 0) throw badRequest(`${k} must be a positive amount.`);
        charges[k] = Math.round(n);
    }
    putDoc(row.id, kind, { ...doc, charges }, actorOf(req));
    res.json(liabilityState(row, kind));
});

function liabilityPdf(res, row, kind) {
    const s = liabilityState(row, kind);
    const c = toClaim(row);
    const table = (t) => [
        { text: t.columns.join('  |  '), bold: true, size: 9, gap: 4 },
        ...t.rows.map((r) => ({ cols: [r.label, r.values.map((v) => inr(v)).join('   ')], size: 9, bold: !!r.bold })),
    ];
    sendPdf(res, `${KINDS[kind].file}-${c.claimNo}.pdf`, [
        { text: `IBIMA ASSIST - ${KINDS[kind].title}`, size: 14, bold: true, align: 'center' },
        { text: `${c.claimNo} · ${c.insuredName ?? ''} · ${c.vehicleNo ?? ''}`, size: 9, align: 'center', gap: 2 },
        { rule: true, gap: 8 },
        { text: 'Parts assessment', bold: true, size: 11 },
        ...s.parts.map((p) => ({ cols: [`${p.srNo}. ${p.part} (${p.material}, ${p.action}, ${p.allowed}, dep ${p.depreciationPct}%)`, `Rs. ${inr(p.partPrice)}`], size: 9 })),
        { text: 'Parts computation', bold: true, size: 11, gap: 8 }, ...table(s.tables.parts),
        { text: 'Labour computation', bold: true, size: 11, gap: 8 }, ...table(s.tables.labour),
        { text: 'Additional charges & deductions', bold: true, size: 11, gap: 8 }, ...table(s.tables.charges),
        { text: 'Final assessment', bold: true, size: 11, gap: 8 }, ...table(s.tables.final),
        { text: `Status: ${s.status}${s.submittedAt ? ` (${fmtDateTime(s.submittedAt)} by ${s.submittedBy})` : ''}`, size: 9, gap: 10 },
    ]);
}

/** POST /api/v1/claims/:id/(liability|fla)/report -- "Generate Report": the PDF. */
router.post(`${KIND_PATH}/report`, canKind(), (req, res) => {
    const { kind } = req.params;
    const row = openClaim(req);
    const doc = liabilityDoc(row.id, kind);
    if (!(doc.parts ?? []).length) throw badRequest('Add at least one part first.');
    const { seeded: _s, seededFrom: _f, updatedAt: _u, updatedBy: _b, ...rest } = doc;
    putDoc(row.id, kind, { ...rest, reportGeneratedAt: nowIso() }, actorOf(req));
    audit(row.id, `${KINDS[kind].label} report generated`, null, actorOf(req));
    liabilityPdf(res, findClaimRow(row.id), kind);
});

/**
 * POST /api/v1/claims/:id/(liability|fla)/submit -- "Submit Report". The net
 * liability becomes the claim amount; the FLA submit also completes the FLA step.
 */
router.post(`${KIND_PATH}/submit`, canKind('edit'), asyncHandler(async (req, res) => {
    const { kind } = req.params;
    const row = openClaim(req);
    const doc = editableLiability(row, kind);
    if (!(doc.parts ?? []).some((p) => p.allowed === 'Allowed')) throw badRequest('At least one part must be Allowed.');
    const { totals } = computeLiability(doc);
    const actor = actorOf(req);
    transaction(() => {
        putDoc(row.id, kind, { ...doc, status: 'Submitted', submittedAt: nowIso(), submittedBy: actor.name, totals }, actor);
        setClaimFields(row.id, { amount: totals.netLiability });
        if (kind === 'fla') completeStage(row.id, 'fla', actor);
        audit(row.id, `${KINDS[kind].label} report submitted`, `Net liability ₹${inr(totals.netLiability)}`, actor);
    });
    await syncClaim(row.id);
    res.json(liabilityState(findClaimRow(row.id), kind));
}));

// ======================= Payment Recommendation =======================

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

async function approverInfo(row) {
    const people = await directory(APPROVER_ROLES).catch(() => []);
    const active = people.filter((p) => p.status === 'Active');
    for (const role of APPROVER_ROLES) {
        const same = active.filter((p) => p.roleKey === role);
        const pick = same.find((p) => p.state && p.state === row.state) ?? same[0];
        if (pick) return { role: pick.roleName, name: `${pick.name}${pick.employeeId ? ` (${pick.employeeId})` : ''}`, id: pick.id };
    }
    return null;
}

function financials(row) {
    const items = damageItems(row.id);
    const handler = computeLiability(liabilityDoc(row.id, 'liability')).totals;
    const flaDoc = liabilityDoc(row.id, 'fla');
    const fla = computeLiability(flaDoc).totals;
    const flaDone = flaDoc.status === 'Submitted';
    return {
        aiIla: aiEstimate(items),
        handlerIla: handler.netLiability,
        approvedFla: flaDone ? fla.netLiability : null,
        deductions: flaDone ? fla.deductions : handler.deductions,
        netPayable: flaDone ? fla.netLiability : 0,
        flaDone,
    };
}

function defaultPayees(row, f) {
    const i = parseJson(row.intimation, {});
    if (!i.workshopName) return [];
    return [{ id: 'PY-1', payeeType: 'Workshop', payeeName: i.workshopName, bankName: '', bankBranch: '', ifsc: '', accountNo: '', paymentFor: 'Repair Expenses', amount: f.netPayable, tds: 0 }];
}

async function paymentState(row) {
    const f = financials(row);
    const saved = getDoc(row.id, 'payment');
    const i = parseJson(row.intimation, {});
    const surveyors = ['spot', 'final'].map((t) => activeAssignment(row.id, t)).filter(Boolean).map((a) => a.surveyorName);
    const names = [...new Set([i.workshopName, row.insured_name, ...surveyors].filter(Boolean))];
    const approver = await approverInfo(row);
    const status = saved?.status ?? 'Draft';
    const payees = saved?.payees ?? defaultPayees(row, f);
    const allocated = payees.reduce((s, p) => s + (p.amount || 0), 0);
    return {
        summary: f,
        details: saved?.details ?? { type: 'full', mode: 'neft', priority: 'normal', date: new Date().toISOString().slice(0, 10), remarks: '' },
        payees,
        allocated,
        tds: payees.reduce((s, p) => s + (p.tds || 0), 0),
        unallocated: f.netPayable - allocated,
        status,
        submittedAt: saved?.submittedAt ?? null,
        approval: {
            status: status === 'Pending Approval' ? 'Pending For Approval From Next Level' : status === 'Draft' ? 'Not Submitted Yet' : status,
            nextApprover: approver?.role ?? 'No approver configured',
            dueDate: saved?.dueDate ?? null,
            approverName: approver?.name ?? '—',
        },
        options: { payeeTypes: PAYEE_TYPES, payeeNames: names, paymentFor: PAYMENT_FOR },
    };
}

function cleanPayment(body) {
    const d = body.details ?? {};
    const details = {
        type: PAYMENT_TYPES.includes(d.type) ? d.type : 'full',
        mode: PAYMENT_MODES.includes(d.mode) ? d.mode : 'neft',
        priority: PAYMENT_PRIORITIES.includes(d.priority) ? d.priority : 'normal',
        date: /^\d{4}-\d{2}-\d{2}$/.test(d.date ?? '') ? d.date : new Date().toISOString().slice(0, 10),
        remarks: String(d.remarks ?? '').trim().slice(0, 300),
    };
    const payees = (Array.isArray(body.payees) ? body.payees : []).slice(0, 20).map((p, idx) => {
        if (!PAYEE_TYPES.includes(p.payeeType)) throw badRequest(`Payee row ${idx + 1}: choose a payee type.`);
        if (!PAYMENT_FOR.includes(p.paymentFor)) throw badRequest(`Payee row ${idx + 1}: choose what the payment is for.`);
        const amount = Math.round(Number(p.amount) || 0);
        const tds = Math.round(Number(p.tds) || 0);
        if (amount < 0 || tds < 0) throw badRequest(`Payee row ${idx + 1}: amounts cannot be negative.`);
        if (tds > amount) throw badRequest(`Payee row ${idx + 1}: TDS cannot exceed the amount.`);
        const ifsc = String(p.ifsc ?? '').trim().toUpperCase();
        if (ifsc && !IFSC_RE.test(ifsc)) throw badRequest(`Payee row ${idx + 1}: IFSC code looks wrong (e.g. HDFC0001234).`);
        const accountNo = String(p.accountNo ?? '').replace(/\s/g, '');
        if (accountNo && !/^\d{9,18}$/.test(accountNo)) throw badRequest(`Payee row ${idx + 1}: account number must be 9-18 digits.`);
        return {
            id: /^PY-\d+$/.test(p.id ?? '') ? p.id : `PY-${idx + 1}`,
            payeeType: p.payeeType,
            payeeName: String(p.payeeName ?? '').trim().slice(0, 100),
            bankName: String(p.bankName ?? '').trim().slice(0, 80),
            bankBranch: String(p.bankBranch ?? '').trim().slice(0, 80),
            ifsc,
            accountNo,
            paymentFor: p.paymentFor,
            amount,
            tds,
        };
    });
    return { details, payees };
}

router.get('/claims/:id/payment', can(MODULES.payment), asyncHandler(async (req, res) => res.json(await paymentState(openClaim(req)))));

/** PUT /api/v1/claims/:id/payment { details, payees } -- saved as you edit. */
router.put('/claims/:id/payment', can(MODULES.payment, 'edit'), asyncHandler(async (req, res) => {
    const row = openClaim(req);
    const saved = getDoc(row.id, 'payment');
    if (saved?.status && saved.status !== 'Draft') throw conflict('The recommendation is submitted for approval; it can no longer be changed.');
    const { details, payees } = cleanPayment(req.body ?? {});
    putDoc(row.id, 'payment', { ...(saved ?? {}), details, payees, status: 'Draft' }, actorOf(req));
    res.json(await paymentState(row));
}));

/** POST /api/v1/claims/:id/payment/submit { details?, payees? } -- "Next": recommendation goes for approval. */
router.post('/claims/:id/payment/submit', can(MODULES.payment, 'edit'), asyncHandler(async (req, res) => {
    const row = openClaim(req);
    const saved = getDoc(row.id, 'payment');
    if (saved?.status && saved.status !== 'Draft') throw conflict('Already submitted for approval.');
    const f = financials(row);
    if (!f.flaDone) throw badRequest('Submit the FLA report first.');
    const input = req.body?.payees ? cleanPayment(req.body) : { details: saved?.details ?? cleanPayment({}).details, payees: saved?.payees ?? defaultPayees(row, f) };
    if (!input.payees.length) throw badRequest('Add at least one payee.');
    input.payees.forEach((p, idx) => {
        if (!p.payeeName || !p.bankName || !p.ifsc || !p.accountNo) throw badRequest(`Payee row ${idx + 1}: fill payee name and bank details (edit the row).`);
        if (!p.amount) throw badRequest(`Payee row ${idx + 1}: amount is 0.`);
    });
    const allocated = input.payees.reduce((s, p) => s + p.amount, 0);
    if (allocated > f.netPayable) throw badRequest(`Allocated ₹${inr(allocated)} is more than the net payable ₹${inr(f.netPayable)}.`);
    if (input.details.type === 'full' && allocated !== f.netPayable) throw badRequest(`Full payment: allocate the whole net payable (₹${inr(f.netPayable)}). Unallocated ₹${inr(f.netPayable - allocated)}.`);
    const actor = actorOf(req);
    transaction(() => {
        putDoc(row.id, 'payment', {
            ...input, status: 'Pending Approval', submittedAt: nowIso(), submittedBy: actor.name,
            dueDate: new Date(Date.now() + 24 * 3600_000).toISOString(),
        }, actor);
        setClaimFields(row.id, { amount: f.netPayable });
        completeStage(row.id, 'payment-recommendation', actor);
        audit(row.id, 'Payment recommended', `₹${inr(allocated)} to ${input.payees.map((p) => p.payeeName).join(', ')}`, actor);
    });
    await syncClaim(row.id);
    res.json(await paymentState(findClaimRow(row.id)));
}));

// ======================= Survey Paybill =======================

async function paybillState(row, user) {
    const assignment = activeAssignment(row.id, 'final') ?? activeAssignment(row.id, 'spot');
    const saved = getDoc(row.id, 'paybill');
    const person = assignment ? (await directory(SURVEYOR_ROLES).catch(() => [])).find((u) => u.id === assignment.surveyorId) : null;
    const lines = PAYBILL_LINES.map((l) => {
        const s = saved?.lines?.find((x) => x.key === l.key);
        return { ...l, rate: s?.rate ?? l.rate, qty: s?.qty ?? l.qty, basis: l.key === 'distance' ? `${s?.qty ?? l.qty} Kms` : l.basis };
    });
    const subTotal = lines.reduce((s, l) => s + l.rate * l.qty, 0);
    const gst = subTotal * PAYBILL_GST;
    const seq = row.claim_no.split('-').pop();
    const ex = person?.extra ?? {};
    const generatedAt = saved?.generatedAt ?? null;
    return {
        assigned: !!assignment,
        survey: assignment ? [
            { key: 'surveyorName', label: 'Surveyor Name', value: assignment.surveyorName },
            { key: 'surveyorId', label: 'Surveyor ID', value: assignment.surveyorCode ?? assignment.surveyorId },
            { key: 'surveyorType', label: 'Surveyor Type', value: assignment.surveyType === 'final' ? 'Final Loss Assessment' : 'Spot Survey' },
            { key: 'surveyorDate', label: 'Surveyor Date', value: fmtDate(assignment.assignedAt) },
            { key: 'surveyLocation', label: 'Survey Location', value: [row.city, row.state].filter(Boolean).join(', ') || '—' },
            { key: 'surveyMode', label: 'Survey Mode', value: 'Physical Survey' },
            { key: 'claimHandler', label: 'Claim Handler', value: row.handler_name ? `${row.handler_name} (${row.handler_id})` : '—' },
            { key: 'distance', label: 'Distance Travelled', value: `${lines.find((l) => l.key === 'distance').qty} KMs` },
        ] : [],
        bill: [
            { key: 'billNo', label: 'Bill No:', value: `BILL/${row.claim_no.slice(4, 8)}/${seq}` },
            { key: 'billDate', label: 'Bill Date', value: fmtDate(generatedAt ?? nowIso()) },
            { key: 'billingPeriod', label: 'Billing Period', value: assignment ? `${fmtDate(assignment.assignedAt)} - ${fmtDate(generatedAt ?? nowIso())}` : '—' },
            { key: 'billTo', label: 'Bill To (Insurance Company)', value: user?.organization ?? '—' },
            { key: 'billingAddress', label: 'Billing Address', value: [user?.organization, user?.branch].filter(Boolean).join(',\n') || '—' },
        ],
        lines,
        mode: saved?.mode ?? 'manual',
        remark: saved?.remark ?? '',
        subTotal,
        gst,
        total: subTotal + gst,
        bank: [
            { key: 'holder', label: 'Account Holder Name', value: ex.accountHolder ?? assignment?.surveyorName ?? '—' },
            { key: 'bank', label: 'Bank Name', value: ex.bankName ?? '—' },
            { key: 'account', label: 'Account No', value: ex.accountNo ?? '—' },
            { key: 'ifsc', label: 'IFSC Code', value: ex.ifsc ?? '—' },
            { key: 'accountType', label: 'Account Type', value: ex.accountType ?? '—' },
            { key: 'branch', label: 'Branch', value: ex.bankBranch ?? '—' },
        ],
        documents: currentDocuments(row.id).filter((d) => d.type === 'surveyor-report'),
        status: saved?.status ?? 'Draft',
        generatedAt,
    };
}

router.get('/claims/:id/paybill', can(MODULES.paybill), asyncHandler(async (req, res) => res.json(await paybillState(openClaim(req), req.user))));

function cleanPaybill(body) {
    const lines = (Array.isArray(body.lines) ? body.lines : []).filter((l) => PAYBILL_LINES.some((d) => d.key === l.key)).map((l) => {
        const rate = Number(l.rate);
        const qty = Number(l.qty ?? PAYBILL_LINES.find((d) => d.key === l.key).qty);
        if (!Number.isFinite(rate) || rate < 0 || rate > 1_000_000) throw badRequest('Rates must be positive amounts.');
        if (!Number.isFinite(qty) || qty < 0 || qty > 10_000) throw badRequest('Quantities must be positive.');
        return { key: l.key, rate: Math.round(rate * 100) / 100, qty };
    });
    return {
        lines,
        mode: body.mode === 'auto' ? 'auto' : 'manual',
        remark: String(body.remark ?? '').slice(0, 500),
    };
}

/** PUT /api/v1/claims/:id/paybill { lines: [{ key, rate, qty }], mode, remark } -- "Save As Draft". */
router.put('/claims/:id/paybill', can(MODULES.paybill, 'edit'), asyncHandler(async (req, res) => {
    const row = openClaim(req);
    const saved = getDoc(row.id, 'paybill');
    const input = cleanPaybill(req.body ?? {});
    // Auto = the standard fee schedule (rates are not editable).
    if (input.mode === 'auto') input.lines = PAYBILL_LINES.map((l) => ({ key: l.key, rate: l.rate, qty: input.lines.find((x) => x.key === l.key)?.qty ?? l.qty }));
    putDoc(row.id, 'paybill', { ...(saved ?? {}), ...input, status: saved?.status ?? 'Draft' }, actorOf(req));
    audit(row.id, 'Paybill saved', null, actorOf(req));
    res.json(await paybillState(findClaimRow(row.id), req.user));
}));

/** POST /api/v1/claims/:id/paybill/pdf { lines?, mode?, remark? } -- "Generate PDF": saves, completes the stage, returns the bill. */
router.post('/claims/:id/paybill/pdf', can(MODULES.paybill, 'edit'), asyncHandler(async (req, res) => {
    const row = openClaim(req);
    const saved = getDoc(row.id, 'paybill');
    const input = req.body?.lines ? cleanPaybill(req.body) : {};
    const actor = actorOf(req);
    if (!activeAssignment(row.id, 'final') && !activeAssignment(row.id, 'spot')) throw badRequest('No surveyor is assigned to this claim.');
    putDoc(row.id, 'paybill', { ...(saved ?? {}), ...input, status: 'Generated', generatedAt: nowIso(), generatedBy: actor.name }, actor);
    const s = await paybillState(findClaimRow(row.id), req.user);
    transaction(() => {
        completeStage(row.id, 'survey-paybill', actor);
        audit(row.id, 'Paybill generated', `₹${inr2(s.total)}`, actor);
    });
    syncClaim(row.id).catch(() => {});
    sendPdf(res, `Paybill-${row.claim_no}.pdf`, [
        { text: 'IBIMA ASSIST - SURVEY FEE BILL', size: 14, bold: true, align: 'center' },
        { text: `${row.claim_no} · ${row.insured_name ?? ''} · ${row.vehicle_no ?? ''}`, size: 9, align: 'center', gap: 2 },
        { rule: true, gap: 8 },
        ...s.bill.map((b) => ({ cols: [b.label.replace(/:$/, ''), b.value.replace(/\n/g, ' ')] })),
        { rule: true, gap: 4 },
        { text: 'Survey details', bold: true, size: 11 },
        ...s.survey.map((b) => ({ cols: [b.label, b.value] })),
        { rule: true, gap: 4 },
        { text: 'Particulars', bold: true, size: 11 },
        ...s.lines.map((l) => ({ cols: [`${l.label} (${l.basis}) @ ${inr2(l.rate)}`, inr2(l.rate * l.qty)] })),
        { cols: ['Sub Total', inr2(s.subTotal)], gap: 6 },
        { cols: [`GST (${Math.round(PAYBILL_GST * 100)}%)`, inr2(s.gst)] },
        { cols: ['Total Payable', inr2(s.total)], bold: true },
        { rule: true, gap: 4 },
        { text: 'Bank details (NEFT/RTGS)', bold: true, size: 11 },
        ...s.bank.map((b) => ({ cols: [b.label, b.value] })),
        ...(s.remark ? [{ text: `Remarks: ${s.remark}`, gap: 8 }] : []),
        { text: `Generated ${fmtDateTime(s.generatedAt)} by ${actor.name}`, size: 8, gap: 12 },
    ]);
}));

export default router;
