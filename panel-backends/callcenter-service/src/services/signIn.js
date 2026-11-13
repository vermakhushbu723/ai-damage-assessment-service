import { settings } from '../config.js';
import { HttpError } from '../utils/http.js';
import { clientOf, identifyAccount } from './adminClient.js';

// The website's common login (/login): which portal an account belongs to, and
// signing in to the Super Admin / Admin portals' own backends on the user's behalf.

const TIMEOUT_MS = 10_000;

async function post(base, path, body, req, headers = {}) {
    try {
        return await fetch(`${base}/api/v1${path}`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...clientOf(req), ...headers },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        throw new HttpError(503, 'The sign-in service is not reachable. Try again in a moment.');
    }
}

/** 'superadmin' | 'admin' | 'user' | null for a sign-in name (email, mobile or user ID). */
export async function accountKind(identifier, req) {
    if (settings.superadminServiceUrl && settings.superadminServiceKey) {
        const res = await post(settings.superadminServiceUrl, '/internal/identify', { identifier }, req, { 'X-Service-Key': settings.superadminServiceKey });
        if (!res.ok) throw new HttpError(503, 'Super Admin sign-in is not available right now. Try again in a moment.');
        if ((await res.json()).exists) return 'superadmin';
    }
    return (await identifyAccount(identifier, req)).kind ?? null;
}

/** POSTs the credentials to that portal's own /auth/login; its 4xx reason (wrong password, locked) goes to the user as-is. */
export async function forwardLogin(kind, identifier, password, req) {
    const base = kind === 'superadmin' ? settings.superadminServiceUrl : settings.adminServiceUrl;
    const res = await post(base, '/auth/login', { identifier, password }, req);
    const data = await res.json().catch(() => null);
    if (res.ok) return data;
    if (res.status >= 400 && res.status < 500) throw new HttpError(res.status, data?.detail || 'Invalid user ID or password.');
    throw new HttpError(503, 'Sign-in service error. Try again in a moment.');
}
