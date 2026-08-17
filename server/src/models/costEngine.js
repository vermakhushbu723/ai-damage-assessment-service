// Severity scoring + repair/replace decision + cost roll-up.
//
// Per docs/ARCHITECTURE.md: severity is deliberately a small, deterministic
// model here (threshold rules on mask_area_ratio), not a deep net -- this is
// the v1 stand-in for the small gradient-boosted/tabular classifier the
// architecture doc recommends training once you have enough
// handler-corrected severity labels to fit one. Swap `scoreSeverity` for a
// real model call when that data exists; nothing else in this file needs to
// change, since everything downstream just consumes a severity tier string.
//
// The repair-vs-replace decision and every dollar figure here are computed
// in code, not by an LLM -- see llmReport.js ("LLM as writer, not
// calculator").

import { db } from '../db/database.js';

// Parts where even "moderate" damage warrants replacement rather than
// repair, because they're structural/safety-critical. Extend this set with
// your own engineering/claims-policy input.
const STRUCTURAL_PARTS = new Set([
    'chassis_rail',
    'windshield_front',
    'windshield_rear',
    'headlamp_lh',
    'headlamp_rh',
    'tail_light_lh',
    'tail_light_rh',
]);

// Fallback per-line cost when a part isn't in the Parts Rate DB yet, so the
// API still returns a usable (clearly-flagged) estimate instead of erroring.
const FALLBACK_ESTIMATE = {
    part_cost: 5000,
    labor_cost: 1500,
    paint_consumables_cost: 2000,
};

function scoreSeverity(detection) {
    const ratio = detection.mask_area_ratio;
    const isStructural = STRUCTURAL_PARTS.has(detection.part);

    if (detection.damage_type === 'glass_shatter') return 'severe'; // glass_shatter is always severe regardless of area

    if (isStructural) {
        if (ratio > 0.25) return 'severe';
        if (ratio > 0.05) return 'moderate';
        return 'minor';
    }

    if (ratio > 0.4) return 'severe';
    if (ratio > 0.15) return 'moderate';
    return 'minor';
}

function decideAction(severity, part) {
    if (severity === 'severe') return 'replace';
    if (severity === 'moderate' && STRUCTURAL_PARTS.has(part)) return 'replace';
    return 'repair';
}

const rateQuery = db.prepare(`
    SELECT part_cost, labor_cost, paint_consumables_cost, region
    FROM parts_rates
    WHERE make = ? AND model = ? AND part = ? AND year_from <= ? AND year_to >= ?
      AND (region = ? OR region = 'default')
    ORDER BY (region = ?) DESC
    LIMIT 1
`);

function lookupRate(vehicle, part) {
    const row = rateQuery.get(
        vehicle.make, vehicle.model, part, vehicle.year, vehicle.year,
        vehicle.region, vehicle.region
    );
    if (!row) return { rates: { ...FALLBACK_ESTIMATE }, source: 'fallback_estimate' };
    return {
        rates: {
            part_cost: row.part_cost,
            labor_cost: row.labor_cost,
            paint_consumables_cost: row.paint_consumables_cost,
        },
        source: 'parts_rate_db',
    };
}

export function assessDamage({ vehicle, detections, photoId = null }) {
    const lineItems = detections.map((detection) => {
        const severity = scoreSeverity(detection);
        const action = decideAction(severity, detection.part);
        const { rates, source } = lookupRate(vehicle, detection.part);

        // Repairing (not replacing) a part doesn't need a new part -- only
        // labor + paint/consumables.
        const partCost = action === 'replace' ? rates.part_cost : 0;
        const laborCost = rates.labor_cost;
        const paintCost = rates.paint_consumables_cost;

        return {
            part: detection.part,
            damage_type: detection.damage_type,
            severity,
            action,
            part_cost: partCost,
            labor_cost: laborCost,
            paint_consumables_cost: paintCost,
            line_total: partCost + laborCost + paintCost,
            rate_source: source,
        };
    });

    const totalCost = lineItems.reduce((sum, item) => sum + item.line_total, 0);

    return {
        photo_id: photoId,
        vehicle,
        line_items: lineItems,
        total_cost: totalCost,
    };
}
