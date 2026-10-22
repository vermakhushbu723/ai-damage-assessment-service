import { settings } from '../config.js';
import { HttpError } from '../utils/http.js';

// AI ILA backend: ai-training-backend/server (POST /api/v1/detect -> YOLO,
// POST /api/v1/assess -> cost engine, POST /api/v1/corrections -> retraining
// queue). Optional: with AI_SERVICE_URL empty the portal says "AI not
// connected" and reviewers add the damaged parts themselves.

export const aiConfigured = () => !!settings.aiServiceUrl;

async function aiFetch(path, init, timeoutMs = 60_000) {
    if (!aiConfigured()) throw new HttpError(503, 'AI service is not connected (AI_SERVICE_URL is empty).');
    let res;
    try {
        res = await fetch(`${settings.aiServiceUrl}/api/v1${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
        throw new HttpError(503, `AI service not reachable: ${err.message}`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const detail = typeof data?.detail === 'string' ? data.detail : JSON.stringify(data?.detail ?? data ?? {}).slice(0, 200);
        throw new HttpError(503, `AI service error (${res.status}): ${detail}`);
    }
    return data;
}

/** One photo -> { photo_id, detections: [{ part, damage_type, mask_polygon, confidence, mask_area_ratio }], model_checkpoint, is_placeholder_model } */
export function detect(buffer, mime, fileName, vehicleType) {
    const form = new FormData();
    form.append('vehicle_type', vehicleType);
    form.append('photo', new Blob([buffer], { type: mime }), fileName);
    return aiFetch('/detect', { method: 'POST', body: form });
}

/** Detections of one photo -> { line_items: [{ part, damage_type, severity, action, part_cost, labor_cost, paint_consumables_cost, line_total }], total_cost } */
export const assess = (vehicle, detections, photoId) => aiFetch('/assess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vehicle, detections, photo_id: photoId }),
});

/** One reviewer correction into the retraining queue. */
export const sendCorrection = (body) => aiFetch('/corrections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
}, 15_000);

let statsCache = null;
/** Retraining queue numbers for the feedback loop card; null when not connected. Cached 60 s. */
export async function retrainingStats() {
    if (!aiConfigured()) return null;
    if (statsCache && Date.now() - statsCache.at < 60_000) return statsCache.value;
    let value = null;
    try {
        value = await aiFetch('/corrections/stats', { method: 'GET' }, 5000);
    } catch {
        value = null;
    }
    statsCache = { value, at: Date.now() };
    return value;
}
