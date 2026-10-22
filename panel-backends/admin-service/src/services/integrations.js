import { findRecord, listRecords, updateRecord } from '../models/recordModel.js';

// External connections of System Settings > API Integration (stored in the
// `integrations` record list). The API key is kept server-side only.

const SLOW_MS = 2000;
const TIMEOUT_MS = 8000;

export const toIntegrationDto = ({ apiKey, ...it }) => ({ ...it, hasApiKey: !!apiKey });
export const listIntegrations = () => listRecords('integrations', { order: 'asc' }).map(toIntegrationDto);

const authHeaders = (apiKey) => (apiKey ? { Authorization: `Bearer ${apiKey}`, 'X-API-Key': apiKey } : {});

/**
 * Calls the configured endpoint (GET) and stores the result:
 * Connected (< 2 s, no 4xx/5xx), Warning (slow or 4xx), Failed (unreachable, timeout or 5xx).
 */
export async function testIntegration(id) {
    const it = findRecord('integrations', id);
    const started = Date.now();
    let status = 'Connected';
    let error = null;
    let httpStatus = null;
    try {
        const response = await fetch(it.endpoint, { headers: authHeaders(it.apiKey), signal: AbortSignal.timeout(TIMEOUT_MS) });
        httpStatus = response.status;
        await response.arrayBuffer().catch(() => {});
        const ms = Date.now() - started;
        if (response.status >= 500) { status = 'Failed'; error = `HTTP ${response.status}`; }
        else if (response.status >= 400) { status = 'Warning'; error = `HTTP ${response.status}`; }
        else if (ms > SLOW_MS) { status = 'Warning'; error = `Slow response (${(ms / 1000).toFixed(1)} s)`; }
    } catch (err) {
        status = 'Failed';
        error = err.name === 'TimeoutError' ? `No response in ${TIMEOUT_MS / 1000} s` : (err.cause?.code || err.message);
    }
    const responseSec = Math.round((Date.now() - started) / 100) / 10;
    const updated = updateRecord('integrations', id, { status, responseSec, lastError: error, syncAt: new Date().toISOString() });
    return { ...toIntegrationDto(updated), httpStatus };
}

export class GatewayError extends Error {}

/**
 * Sends one message through the Communication Gateway integration:
 * POST <endpoint> { channel, to, recipient, message, claim, reference }.
 * Resolves on HTTP 2xx, otherwise throws GatewayError with a readable reason.
 */
export async function sendViaGateway(gatewayId, payload) {
    const gw = findRecord('integrations', gatewayId);
    if (!gw?.endpoint) throw new GatewayError('The Communication Gateway is not configured — set its endpoint in System Settings > API Integration.');
    let response;
    try {
        response = await fetch(gw.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(gw.apiKey) },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        await response.arrayBuffer().catch(() => {});
    } catch (err) {
        throw new GatewayError(`Communication Gateway unreachable (${err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message}).`);
    }
    if (!response.ok) throw new GatewayError(`Communication Gateway answered HTTP ${response.status}.`);
}
