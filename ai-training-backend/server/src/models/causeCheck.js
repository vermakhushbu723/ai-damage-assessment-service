// Cause-of-loss consistency check.
//
// Deliberately rule-based and deterministic: it compares the parts a
// claim's *reported* cause would typically damage against the parts
// actually detected, and produces a numeric score. An LLM only ever
// phrases this result for a human reader (see llmReport.js) -- it never
// makes this call itself, so "why was this claim flagged" always traces to
// an inspectable table, not a model's opinion.
//
// Extend CAUSE_TO_EXPECTED_PARTS with your own claims-ops taxonomy; keys
// should match however "reported cause" is captured on your claim
// intimation form (loosely matched here via substring so near-variants
// still hit).

const CAUSE_TO_EXPECTED_PARTS = {
    rear_ended: new Set(['rear_bumper', 'tail_light_lh', 'tail_light_rh', 'boot_lid', 'trunk']),
    front_collision: new Set(['front_bumper', 'bonnet', 'headlamp_lh', 'headlamp_rh', 'windshield_front', 'front_door_lh', 'front_door_rh']),
    side_collision_left: new Set(['front_door_lh', 'rear_door_lh', 'fender_lh', 'side_panel_lh']),
    side_collision_right: new Set(['front_door_rh', 'rear_door_rh', 'fender_rh', 'side_panel_rh']),
    hit_divider: new Set(['front_bumper', 'fender_lh', 'fender_rh', 'headlamp_lh', 'headlamp_rh']),
    parking_scratch: new Set(['front_bumper', 'rear_bumper', 'fender_lh', 'fender_rh', 'front_door_lh', 'front_door_rh']),
    windshield_only: new Set(['windshield_front', 'windshield_rear']),
    rollover: new Set(['bonnet', 'roof', 'front_bumper', 'rear_bumper', 'windshield_front']),
};

function matchCauseKey(reportedCause) {
    const normalized = reportedCause.trim().toLowerCase().replace(/ /g, '_').replace(/-/g, '_');
    for (const key of Object.keys(CAUSE_TO_EXPECTED_PARTS)) {
        if (normalized.includes(key) || key.includes(normalized)) return key;
    }
    return null;
}

export function checkCauseConsistency(reportedCause, detections) {
    const detectedParts = [...new Set(detections.map((d) => d.part))].sort();
    const causeKey = matchCauseKey(reportedCause);

    if (causeKey === null) {
        // Unknown/unmapped cause category -- don't fabricate a consistency
        // judgement for a cause we don't have a rule for.
        return {
            reported_cause: reportedCause,
            consistency_score: 1.0,
            is_consistent: true,
            expected_parts: [],
            detected_parts: detectedParts,
            explanation: (
                `Reported cause '${reportedCause}' isn't in the cause-to-parts rule table yet, ` +
                'so no consistency check was applied. Add it to CAUSE_TO_EXPECTED_PARTS in ' +
                'server/src/models/causeCheck.js.'
            ),
        };
    }

    const expectedParts = CAUSE_TO_EXPECTED_PARTS[causeKey];
    const detectedSet = new Set(detectedParts);

    let score;
    if (detectedSet.size === 0) {
        score = 1.0; // no damage detected yet -- nothing to be inconsistent with
    } else {
        const overlap = [...detectedSet].filter((p) => expectedParts.has(p));
        score = overlap.length / detectedSet.size;
    }

    const isConsistent = score >= 0.5;
    const sortedExpected = [...expectedParts].sort();

    const explanation = isConsistent
        ? `Detected damage on ${detectedParts.join(', ') || 'no parts'} is consistent with the ` +
          `reported cause ('${reportedCause}'), which typically affects ${sortedExpected.join(', ')}.`
        : `Reported cause ('${reportedCause}') would typically show damage on ${sortedExpected.join(', ')}. ` +
          `Detected damage is instead on ${detectedParts.join(', ')}, which does not match -- flagged for review.`;

    return {
        reported_cause: reportedCause,
        consistency_score: Math.round(score * 100) / 100,
        is_consistent: isConsistent,
        expected_parts: sortedExpected,
        detected_parts: detectedParts,
        explanation,
    };
}
