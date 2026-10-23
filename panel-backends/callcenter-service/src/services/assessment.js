import { db, parseJson } from '../db/database.js';
import { getDoc } from '../models/claimModel.js';
import {
    DEPRECIATION, PARTS_GST, LABOUR_GST, LABOUR_RATES, COMPULSORY_EXCESS, DEFAULT_HSN, TRACKED_FIELDS,
} from '../constants.js';

// The money side of a claim, computed in one place so AI ILA, Handler ILA
// and Payment Recommendation always agree:
//   AI ILA rows (damage_items) -> liability parts -> liability computation -> net payable.

const SEVERITY_ORDER = { Severe: 0, Moderate: 1, Minor: 2 };

export function toItem(r, index) {
    const ai = parseJson(r.ai, null);
    const corrected = ai ? TRACKED_FIELDS.some((f) => ai[f] !== itemValue(r, f)) : false;
    return {
        id: r.id,
        key: String(index + 1).padStart(2, '0'),
        part: r.part,
        damageType: r.damage_type,
        severity: r.severity,
        action: r.action,
        cost: r.cost,
        confidence: r.confidence,
        status: r.status,
        source: r.source,
        documentId: r.document_id,
        box: parseJson(r.box, null),
        ai,
        corrected,
        updatedAt: r.updated_at,
    };
}

function itemValue(r, field) {
    return { damageType: r.damage_type, severity: r.severity, action: r.action, cost: r.cost, status: r.status }[field];
}

/** Active AI ILA rows, most severe first. */
export function damageItems(claimId) {
    return db.prepare('SELECT * FROM damage_items WHERE claim_id = ? AND deleted_at IS NULL ORDER BY created_at, id').all(claimId)
        .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
        .map(toItem);
}

/** AI ILA estimate: every row the reviewer has not rejected. */
export const aiEstimate = (items) => items.filter((i) => i.status !== 'Rejected').reduce((s, i) => s + (i.cost || 0), 0);

/** Best guess of a part's material from its name (reviewer can change it). */
export function guessMaterial(part) {
    const p = String(part).toLowerCase();
    if (/(glass|windshield|wind shield|windscreen)/.test(p)) return 'Glass Fiber';
    if (/(tyre|tire|rubber|beading|seal)/.test(p)) return 'Rubber';
    if (/(bumper|grill|grille|lamp|light|orvm|mirror|cladding|trim|garnish)/.test(p)) return 'Plastic';
    return 'Metal';
}

/** Liability parts seeded from the AI ILA rows (until the handler saves their own). */
export function seedParts(items) {
    return items.filter((i) => i.status !== 'Rejected').map((i, idx) => ({
        id: `LP-${idx + 1}`,
        part: i.part,
        material: guessMaterial(i.part),
        action: i.action,
        allowed: 'Allowed',
        remarks: '',
        hsnCode: DEFAULT_HSN,
        partPrice: i.cost || 0,
        fromItem: i.id,
    }));
}

/**
 * Stored liability document of `kind` ('liability' = Handler ILA, 'fla' = FLA),
 * or a seeded one: Handler ILA from the AI ILA rows, FLA from the Handler ILA.
 */
export function liabilityDoc(claimId, kind = 'liability') {
    const saved = getDoc(claimId, kind);
    if (saved) return saved;
    if (kind === 'fla') {
        const handler = getDoc(claimId, 'liability');
        if (handler?.parts?.length) {
            return { parts: handler.parts.map((p) => ({ ...p })), charges: { ...(handler.charges ?? {}) }, status: 'Draft', seeded: true, seededFrom: 'Handler ILA' };
        }
    }
    return { parts: seedParts(damageItems(claimId)), charges: {}, status: 'Draft', seeded: true, seededFrom: 'AI ILA' };
}

const r0 = (n) => Math.round(n);

/** The four computation tables + totals of the Handler ILA screen. */
export function computeLiability(doc) {
    const parts = (doc.parts ?? []).map((p, i) => {
        const dep = p.action === 'Replace' ? (DEPRECIATION[p.material] ?? 0.5) : 0;
        return { ...p, srNo: String(i + 1).padStart(2, '0'), depreciationPct: Math.round(dep * 100) };
    });
    const allowed = parts.filter((p) => p.allowed === 'Allowed');

    const group = (p) => (p.material === 'Metal' ? 0 : p.material === 'Glass Fiber' ? 2 : 1);
    const gross = [0, 0, 0];
    const depn = [0, 0, 0];
    for (const p of allowed) {
        gross[group(p)] += p.partPrice || 0;
        depn[group(p)] += (p.partPrice || 0) * (p.depreciationPct / 100);
    }
    const net = gross.map((g, i) => g - depn[i]);
    const gst = net.map((n) => n * PARTS_GST);
    const totalParts = net.map((n, i) => n + gst[i]);
    const sum = (a) => a.reduce((s, v) => s + v, 0);

    const replaceCount = allowed.filter((p) => p.action === 'Replace').length;
    const repairCount = allowed.filter((p) => p.action === 'Repair').length;
    const labour = {
        removeRefit: replaceCount * LABOUR_RATES.removeRefit,
        repair: repairCount * LABOUR_RATES.repair,
        paint: allowed.filter((p) => p.material !== 'Glass Fiber' && p.material !== 'Rubber').length * LABOUR_RATES.paint,
    };
    const labourGross = labour.removeRefit + labour.repair + labour.paint;
    const labourGst = labourGross * LABOUR_GST;
    const labourTotal = labourGross + labourGst;

    const c = doc.charges ?? {};
    const charges = {
        towing: Number(c.towing) || 0,
        compulsoryExcess: allowed.length ? -(c.compulsoryExcess ?? COMPULSORY_EXCESS) : 0,
        voluntaryExcess: -(Number(c.voluntaryExcess) || 0),
        salvage: -(Number(c.salvage) || 0),
        other: -(Number(c.other) || 0),
    };
    const deductions = charges.compulsoryExcess + charges.voluntaryExcess + charges.salvage + charges.other;

    const partsAllowed = sum(totalParts);
    const grossLiability = partsAllowed + labourTotal + charges.towing;
    const netLiability = grossLiability + deductions;

    return {
        parts,
        totals: {
            partsPriceAllowed: r0(sum(allowed.map((p) => p.partPrice || 0))),
            partsAllowed: r0(partsAllowed),
            labourAllowed: r0(labourTotal),
            additional: r0(charges.towing),
            grossLiability: r0(grossLiability),
            deductions: r0(deductions),
            netLiability: r0(Math.max(0, netLiability)),
        },
        tables: {
            parts: {
                columns: ['Particulars', 'Metal Parts', 'Plastic/Rubber Parts', 'Glass Fiber Parts', 'Total'],
                rows: [
                    { key: 'gross', label: 'Gross Amount', values: [...gross, sum(gross)].map(r0) },
                    { key: 'depreciation', label: 'Less Depreciation', values: [...depn, sum(depn)].map((v) => -r0(v)) },
                    { key: 'net', label: 'Net Amount', values: [...net, sum(net)].map(r0) },
                    { key: 'gst', label: `GST @ ${Math.round(PARTS_GST * 100)}%`, values: [...gst, sum(gst)].map(r0) },
                    { key: 'total', label: 'Total Allowed Parts', values: [...totalParts, partsAllowed].map(r0), bold: true },
                ],
            },
            labour: {
                columns: ['Particulars', 'Amount'],
                rows: [
                    { key: 'remove-refit', label: 'Remove & Refit Labour', values: [labour.removeRefit] },
                    { key: 'repair', label: 'Repair Labour', values: [labour.repair] },
                    { key: 'paint', label: 'Paint Labour', values: [labour.paint] },
                    { key: 'gross', label: 'Gross Labour', values: [labourGross] },
                    { key: 'gst', label: `GST @ ${Math.round(LABOUR_GST * 100)}%`, values: [r0(labourGst)] },
                    { key: 'total', label: 'Total Labour Allowed', values: [r0(labourTotal)], bold: true },
                ],
            },
            charges: {
                columns: ['Particulars', 'Amount'],
                rows: [
                    { key: 'towing', label: 'Additional Charges (Towing Etc)', values: [charges.towing] },
                    { key: 'compulsory-excess', label: 'Compulsory Excess', values: [charges.compulsoryExcess] },
                    { key: 'voluntary-excess', label: 'Voluntary Excess', values: [charges.voluntaryExcess] },
                    { key: 'salvage', label: 'Salvage Value', values: [charges.salvage] },
                    { key: 'other', label: 'Other Deduction', values: [charges.other] },
                    { key: 'total', label: 'Total Deductions', values: [r0(deductions)], bold: true },
                ],
            },
            final: {
                columns: ['Particulars', 'Amount'],
                rows: [
                    { key: 'parts', label: 'Total Allowed Parts', values: [r0(partsAllowed)] },
                    { key: 'labour', label: 'Total Labour Allowed', values: [r0(labourTotal)] },
                    { key: 'additional', label: 'Additional Charges', values: [r0(charges.towing)] },
                    { key: 'gross', label: 'Gross Liability', values: [r0(grossLiability)] },
                    { key: 'deductions', label: 'Less: Total Deductions', values: [r0(deductions)] },
                    { key: 'net', label: 'Net Liability', values: [r0(Math.max(0, netLiability))], bold: true },
                ],
            },
        },
        labour,
        charges,
    };
}
