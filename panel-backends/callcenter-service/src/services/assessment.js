import { db, parseJson } from '../db/database.js';
import { getDoc } from '../models/claimModel.js';
import {
    DEPRECIATION, PARTS_GST, LABOUR_GST, LABOUR_RATES, COMPULSORY_EXCESS, DEFAULT_HSN, TRACKED_FIELDS,
    METAL_DEPRECIATION, METAL_DEPRECIATION_DEFAULT, PAINT_MATERIAL_SHARE, PAINT_MATERIAL_DEPRECIATION, IMT23_DEDUCTION, LEGACY_MATERIAL,
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
    if (/(fibre|fiber)/.test(p)) return 'Fibre Glass';
    if (/(glass|windshield|wind shield|windscreen)/.test(p)) return 'Glass';
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
const r2 = (n) => Math.round(n * 100) / 100;

/** Vehicle age in months at the date of loss (manufacturing year / registration date of the intimation). */
export function vehicleAgeMonths(row) {
    const i = parseJson(row?.intimation, {});
    const from = Date.parse(i.registrationDate ?? '') || Date.parse(i.manufacturingYear ?? '');
    if (!from) return null;
    const to = Date.parse(i.dateOfIncident ?? '') || Date.now();
    return Math.max(0, Math.floor((to - from) / (30.4375 * 24 * 3600 * 1000)));
}

export const metalDepreciation = (ageMonths) => (ageMonths == null ? METAL_DEPRECIATION_DEFAULT : METAL_DEPRECIATION.find(([upTo]) => ageMonths <= upTo)[1]);
const materialOf = (m) => LEGACY_MATERIAL[m] ?? m;

/**
 * The Handler ILA / FLA computation (Figma: Parts Assessment + 1. Component Cost
 * Summary, 2. Labour Cost Summary, 3. Remarks, 4. Final Settlement Summary).
 * Every row: Gross - Depn - IMT 23 = Net. Depreciation only on replaced parts.
 */
export function computeLiability(doc, { ageMonths = null } = {}) {
    const metalRate = metalDepreciation(ageMonths);
    const parts = (doc.parts ?? []).map((p, i) => {
        const material = materialOf(p.material);
        const rate = p.action === 'Replace' ? (material === 'Metal' ? metalRate : DEPRECIATION[material] ?? 0.5) : 0;
        return { ...p, material, imt23: !!p.imt23, srNo: String(i + 1).padStart(2, '0'), depreciationPct: Math.round(rate * 100), _rate: rate };
    });
    const allowed = parts.filter((p) => p.allowed === 'Allowed');
    const sum = (a) => a.reduce((s, v) => s + v, 0);

    // ---- 1. Component Cost Summary ----
    const GROUPS = [
        { key: 'metal', label: `Metal Parts ${Math.round(metalRate * 100)}% Depreciation`, has: (m) => m === 'Metal', always: true },
        { key: 'plastic', label: 'Plastic / Rubber Parts 50% Depreciation', has: (m) => m === 'Plastic' || m === 'Rubber', always: true },
        { key: 'fibre', label: 'Fibre Glass Parts 30% Depreciation', has: (m) => m === 'Fibre Glass' },
        { key: 'glass', label: 'Parts - Glass Nil Depreciation', has: (m) => m === 'Glass', always: true },
    ];
    const line = (list) => {
        const gross = sum(list.map((p) => p.partPrice || 0));
        const depn = sum(list.map((p) => (p.partPrice || 0) * p._rate));
        const imt = sum(list.filter((p) => p.imt23).map((p) => ((p.partPrice || 0) * (1 - p._rate)) * IMT23_DEDUCTION));
        return { gross, depn, imt, net: gross - depn - imt };
    };
    const groupLines = GROUPS.map((g) => ({ ...g, ...line(allowed.filter((p) => g.has(p.material))) })).filter((g) => g.always || g.gross);
    const partsBase = line(allowed);
    const partsTax = { gross: partsBase.gross * PARTS_GST, depn: partsBase.depn * PARTS_GST, imt: partsBase.imt * PARTS_GST, net: partsBase.net * PARTS_GST };
    const partsTotal = { gross: partsBase.gross + partsTax.gross, depn: partsBase.depn + partsTax.depn, imt: partsBase.imt + partsTax.imt, net: partsBase.net + partsTax.net };

    // ---- 2. Labour Cost Summary ----
    const replaced = allowed.filter((p) => p.action === 'Replace');
    const repaired = allowed.filter((p) => p.action === 'Repair');
    const painted = allowed.filter((p) => p.material !== 'Glass' && p.material !== 'Rubber');
    const labourOfd = { gross: replaced.length * LABOUR_RATES.removeRefit + repaired.length * LABOUR_RATES.repair, depn: 0, imt: 0 };
    labourOfd.net = labourOfd.gross;
    const paintShare = (list, share) => sum(list.map(() => LABOUR_RATES.paint * share));
    const paintLabour = { gross: paintShare(painted, 1 - PAINT_MATERIAL_SHARE), depn: 0 };
    paintLabour.imt = paintShare(painted.filter((p) => p.imt23), 1 - PAINT_MATERIAL_SHARE) * IMT23_DEDUCTION;
    paintLabour.net = paintLabour.gross - paintLabour.imt;
    const paintMaterial = { gross: paintShare(painted, PAINT_MATERIAL_SHARE) };
    paintMaterial.depn = paintMaterial.gross * PAINT_MATERIAL_DEPRECIATION;
    paintMaterial.imt = paintShare(painted.filter((p) => p.imt23), PAINT_MATERIAL_SHARE) * (1 - PAINT_MATERIAL_DEPRECIATION) * IMT23_DEDUCTION;
    paintMaterial.net = paintMaterial.gross - paintMaterial.depn - paintMaterial.imt;
    const labourBase = ['gross', 'depn', 'imt', 'net'].reduce((o, k) => ({ ...o, [k]: labourOfd[k] + paintLabour[k] + paintMaterial[k] }), {});
    const labourTax = ['gross', 'depn', 'imt', 'net'].reduce((o, k) => ({ ...o, [k]: labourBase[k] * LABOUR_GST }), {});
    const labourTotal = ['gross', 'depn', 'imt', 'net'].reduce((o, k) => ({ ...o, [k]: labourBase[k] + labourTax[k] }), {});

    // ---- 4. Final Settlement Summary ----
    const c = doc.charges ?? {};
    const amt = (k) => Math.max(0, Number(c[k]) || 0);
    const charges = {
        towing: amt('towing'),
        onSiteRepair: amt('onSiteRepair'),
        policyBenefits: amt('policyBenefits'),
        additionalBenefits: amt('additionalBenefits'),
        depreciationRefund: amt('depreciationRefund'),
        compulsoryExcess: allowed.length ? -(c.compulsoryExcess ?? COMPULSORY_EXCESS) : 0,
        voluntaryExcess: -amt('voluntaryExcess'),
        salvage: -amt('salvage'),
        other: -amt('other'),
        extraDeduction: -amt('extraDeduction'),
    };
    const partialDamage = partsTotal.net + labourTotal.net;
    const additions = charges.towing + charges.onSiteRepair + charges.policyBenefits + charges.additionalBenefits + charges.depreciationRefund;
    const totalAssessed = partialDamage + additions;
    const deductions = charges.compulsoryExcess + charges.voluntaryExcess + charges.salvage + charges.other + charges.extraDeduction;
    const finalPayable = Math.max(0, totalAssessed + deductions);

    const row4 = (key, label, v, bold = false) => ({ key, label, values: [r2(v.gross), r2(v.depn), r2(v.imt), r2(v.net)], ...(bold ? { bold: true } : {}) });
    const COLS = ['Gross Amount', 'Depn', 'IMT 23', 'Net Amount'];
    return {
        parts: parts.map(({ _rate, ...p }) => p),
        ageMonths,
        metalDepreciationPct: Math.round(metalRate * 100),
        remarks: doc.summaryRemarks ?? '',
        totals: {
            partsPriceAllowed: r0(partsBase.gross),
            partsAllowed: r0(partsTotal.net),
            labourAllowed: r0(labourTotal.net),
            additional: r0(additions),
            partialDamage: r0(partialDamage),
            grossLiability: r0(totalAssessed),
            deductions: r0(deductions),
            netLiability: r0(finalPayable),
        },
        tables: {
            parts: {
                title: '1. Component Cost Summary',
                columns: ['Parts Computation', ...COLS],
                rows: [
                    ...groupLines.map((g) => row4(g.key, g.label, g)),
                    row4('tax', `Tax on Parts Allowed (GST ${Math.round(PARTS_GST * 100)}%)`, partsTax),
                    row4('total', 'Total on Parts Allowed', partsTotal, true),
                ],
            },
            labour: {
                title: '2. Labour Cost Summary',
                columns: ['Labour Computation', ...COLS],
                rows: [
                    row4('ofd', 'Labour O/F/D', labourOfd),
                    row4('paint-labour', 'Paint Labour', paintLabour),
                    row4('paint-material', 'Paint Material', paintMaterial),
                    row4('tax', `Tax on Labour Allowed (GST ${Math.round(LABOUR_GST * 100)}%)`, labourTax),
                    row4('total', 'Total on Labour Allowed', labourTotal, true),
                ],
            },
            final: {
                title: '4. Final Settlement Summary',
                columns: ['Settlement Computation', 'Net Amount'],
                rows: [
                    { key: 'category', label: 'Settlement Category', text: 'Partial Loss' },
                    { key: 'partial', label: 'Partial Damage (Parts + Labour)', values: [r2(partialDamage)] },
                    { key: 'depreciationRefund', label: 'Depreciation Refund', values: [charges.depreciationRefund], editable: true },
                    { key: 'additionalBenefits', label: 'Additional Benefits', values: [charges.additionalBenefits], editable: true },
                    { key: 'policyBenefits', label: 'Policy Benefits', values: [charges.policyBenefits], editable: true },
                    { key: 'towing', label: 'Towing Charges', values: [charges.towing], editable: true },
                    { key: 'onSiteRepair', label: 'On-Site Repair Cost', values: [charges.onSiteRepair], editable: true },
                    { key: 'assessed', label: 'Total Assessed Claim', values: [r2(totalAssessed)], bold: true },
                    { key: 'compulsoryExcess', label: 'Mandatory Deductible', values: [charges.compulsoryExcess], editable: true, deduction: true },
                    { key: 'voluntaryExcess', label: 'Voluntary Deductible', values: [charges.voluntaryExcess], editable: true, deduction: true },
                    { key: 'salvage', label: 'Recoverable Salvage Amount', values: [charges.salvage], editable: true, deduction: true },
                    { key: 'other', label: 'Miscellaneous Deductions', values: [charges.other], editable: true, deduction: true },
                    { key: 'extraDeduction', label: 'Extra Deduction', values: [charges.extraDeduction], editable: true, deduction: true },
                    { key: 'net', label: 'Final Payable Amount', values: [r0(finalPayable)], bold: true },
                ],
            },
        },
        labour: { ofd: labourOfd.gross, paintLabour: paintLabour.gross, paintMaterial: paintMaterial.gross },
        charges,
    };
}
