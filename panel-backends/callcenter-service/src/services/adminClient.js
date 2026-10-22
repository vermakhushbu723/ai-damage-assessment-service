import { settings } from '../config.js';
import { HttpError } from '../utils/http.js';

// Calls to admin-service. Users, roles, handlers and surveyors are owned by
// the Admin portal (Admin > Create Users / Roles & Permissions); this service
// only asks for them. Every call carries X-Service-Key and, when it is made
// for a browser request, that browser's IP and User-Agent (Audit Logs).

const TIMEOUT_MS = 8000;

/** Headers that tell admin-service who the real client is. */
export const clientOf = (req) => (req ? {
    'X-Forwarded-For': String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, ''),
    'User-Agent': String(req.headers['user-agent'] || 'callcenter-service'),
} : { 'User-Agent': 'callcenter-service' });

async function call(method, path, { body, req } = {}) {
    if (!settings.adminServiceKey) {
        throw new HttpError(503, 'Sign-in service is not configured (ADMIN_SERVICE_KEY is empty).');
    }
    let res;
    try {
        res = await fetch(`${settings.adminServiceUrl}/api/v1${path}`, {
            method,
            headers: {
                Accept: 'application/json',
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                'X-Service-Key': settings.adminServiceKey,
                ...clientOf(req),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        throw new HttpError(503, 'User service (admin-service) is not reachable. Try again in a moment.');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        // admin-service's own 4xx reasons (wrong password, locked, ...) go to the user as-is.
        if (res.status === 401 && data?.detail === 'Invalid service key.') throw new HttpError(503, 'Sign-in service rejected this portal (check ADMIN_SERVICE_KEY).');
        if (res.status >= 400 && res.status < 500) throw new HttpError(res.status, data?.detail || 'Request rejected.');
        throw new HttpError(503, data?.detail || 'User service error. Try again in a moment.');
    }
    return data;
}

export const portalLogin = (identifier, password, req) =>
    call('POST', '/internal/portal-login', { body: { identifier, password, portal: 'callcenter' }, req });

export const portalLogout = (userId, req) =>
    call('POST', '/internal/portal-logout', { body: { userId, portal: 'callcenter' }, req }).catch(() => null);

export const changePassword = (userId, currentPassword, newPassword, req) =>
    call('POST', `/internal/users/${encodeURIComponent(userId)}/change-password`, { body: { currentPassword, newPassword }, req });

// ---- signed-in user, re-checked against the Admin portal (short cache) ----
const userCache = new Map(); // id -> { user, at }

export async function getUser(id) {
    const hit = userCache.get(id);
    if (hit && Date.now() - hit.at < settings.userCacheSeconds * 1000) return hit.user;
    try {
        const user = await call('GET', `/internal/users/${encodeURIComponent(id)}`);
        userCache.set(id, { user, at: Date.now() });
        return user;
    } catch (err) {
        if (err.status === 404) {
            userCache.delete(id);
            return null;
        }
        throw err;
    }
}

export const forgetUser = (id) => userCache.delete(id);

// ---- directory: handlers, surveyors, approvers (short cache) ----
const dirCache = new Map(); // roles csv -> { rows, at }
const DIR_CACHE_MS = 15_000;

export async function directory(roles) {
    const key = roles.join(',');
    const hit = dirCache.get(key);
    if (hit && Date.now() - hit.at < DIR_CACHE_MS) return hit.rows;
    const rows = await call('GET', `/internal/directory?roles=${encodeURIComponent(key)}`);
    dirCache.set(key, { rows, at: Date.now() });
    return rows;
}

export const clearDirectoryCache = () => dirCache.clear();

/** The claim as the Admin portal has it (handler allocation, fraud triggers). null if unknown there. */
export async function adminClaim(claimNo) {
    try {
        return await call('GET', `/internal/claims/${encodeURIComponent(claimNo)}`);
    } catch (err) {
        if (err.status === 404) return null;
        throw err;
    }
}

/** POST /claims/ingest -- claims + communication logs. */
export const ingest = (payload) => call('POST', '/claims/ingest', { body: payload });
