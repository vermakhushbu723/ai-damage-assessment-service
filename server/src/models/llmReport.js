// Llama report generation.
//
// Llama is called as a *writer*, never as the source of truth for a number:
// every cost figure, severity tier, and repair/replace decision is computed
// upstream (costEngine.js) and handed to the model as fixed context, along
// with the cause-consistency result (causeCheck.js). The prompt explicitly
// tells it not to invent facts, for exactly that auditability reason.
//
// Talks to a self-hosted Ollama instance (see .env.example) rather than a
// hosted API, per the IP/data-governance requirement -- claim photos and
// cost data never leave your infra. If Ollama isn't reachable (e.g. it's
// not installed/running yet), this degrades to a clearly-labeled
// placeholder string so the rest of the pipeline and the frontend keep
// working during development.

import { settings } from '../config.js';

function buildPrompt(request, causeCheck) {
    const detectionsJson = JSON.stringify(request.detections, null, 2);
    const lineItemsJson = JSON.stringify(request.assessment.line_items, null, 2);

    return `You are drafting a Loss Assessment (ILA) note for a claims handler to review.
Only describe what is in DETECTIONS, DECISIONS, and CONSISTENCY below — do not invent
facts, parts, or figures that aren't present in this context.

VEHICLE: ${request.vehicle.make} ${request.vehicle.model} ${request.vehicle.year}
REPORTED CAUSE OF LOSS: ${request.reported_cause}

DETECTIONS (from the vision model):
${detectionsJson}

REPAIR/REPLACE DECISIONS AND COSTS (already determined by the rule engine — explain, don't recompute):
${lineItemsJson}
TOTAL ESTIMATED COST: ${request.assessment.total_cost}

CAUSE-CONSISTENCY CHECK (already computed by the rule engine):
${causeCheck.explanation}
Consistency score: ${causeCheck.consistency_score} (consistent=${causeCheck.is_consistent})

Write, in plain professional language suitable for a claims handler:
1. A short damage summary, part by part.
2. A one-line justification for each repair/replace decision, referencing severity.
3. A closing note on the cause-consistency check above, in your own words, but without
   changing its conclusion.

Keep it concise — a claims handler should be able to read this in under a minute.`;
}

function placeholderNarrative(request, causeCheck) {
    const lines = [
        '[PLACEHOLDER REPORT — Ollama is not reachable, so this is a templated ' +
        'summary, not an LLM-generated narrative. Run `ollama serve` and ' +
        `\`ollama pull ${settings.ollamaModel}\` to enable real report generation.]`,
        '',
        `Vehicle: ${request.vehicle.make} ${request.vehicle.model} ${request.vehicle.year}`,
        `Reported cause: ${request.reported_cause}`,
        '',
        'Damage summary:',
    ];
    for (const item of request.assessment.line_items) {
        lines.push(
            `- ${item.part}: ${item.damage_type}, severity ${item.severity} ` +
            `-> ${item.action} (₹${item.line_total.toLocaleString('en-IN')})`
        );
    }
    lines.push(`\nTotal estimated cost: ₹${request.assessment.total_cost.toLocaleString('en-IN')}`);
    lines.push(`\nCause-consistency: ${causeCheck.explanation}`);
    return lines.join('\n');
}

/** Returns { narrative, generatedBy } -- generatedBy is 'llama' or 'placeholder_ollama_unreachable'. */
export async function generateReport(request, causeCheck) {
    const prompt = buildPrompt(request, causeCheck);

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), settings.ollamaTimeoutMs);

        const response = await fetch(`${settings.ollamaHost}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: settings.ollamaModel, prompt, stream: false }),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
            console.warn(`Ollama returned an error: ${response.status} ${response.statusText}`);
        } else {
            const body = await response.json();
            const narrative = (body.response || '').trim();
            if (narrative) return { narrative, generatedBy: 'llama' };
            console.warn('Ollama returned an empty response; falling back to placeholder.');
        }
    } catch (err) {
        console.warn(`Ollama unreachable at ${settings.ollamaHost}: ${err.message}`);
    }

    return { narrative: placeholderNarrative(request, causeCheck), generatedBy: 'placeholder_ollama_unreachable' };
}
