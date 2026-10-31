import { settings } from '../config.js';
import { HttpError } from '../utils/http.js';

// Login IDs issued in this console are also created in admin-service
// (POST /api/v1/internal/accounts, X-Service-Key = its CLAIMS_INGEST_KEY), because
// the Admin portal, the call center portal and the apps sign in there.

export const adminPortalConnected = () => Boolean(settings.adminServiceUrl && settings.adminServiceKey);

/** Super Admin user roles -> admin-service role keys ("Admin" becomes an Admin portal login instead). */
const ROLE_KEYS = {
    Manager: 'regional-manager',
    Surveyor: 'external-surveyor',
    'Claim Handler': 'claim-handler',
    'Call Center': 'call-center',
    TCT: 'tct',
    'Sr TCT': 'sr-tct',
    'National Manager': 'national-manager',
};

async function call(method, path, body) {
    let res;
    try {
        res = await fetch(`${settings.adminServiceUrl}/api/v1/internal${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', 'X-Service-Key': settings.adminServiceKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
        });
    } catch {
        throw new HttpError(502, 'The Admin portal (admin-service) is not reachable, so the login could not be created. Try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError([400, 404, 409].includes(res.status) ? res.status : 502, `Admin portal: ${data.detail ?? `HTTP ${res.status}`}`);
    return data;
}

/**
 * Creates the login in admin-service. `role` is a Super Admin user role; "Admin" (and an
 * organization's own admin) gets an Admin portal login, every other role a user account.
 * Returns { kind, id, portal } or null when admin-service is not connected.
 */
export async function createPortalLogin({ id, name, email, phone, password, role, status, organization, branch, platform }) {
    if (!adminPortalConnected()) return null;
    if (role === 'Admin') return call('POST', '/accounts', { kind: 'admin', id, name, email, mobile: phone ?? undefined, password });
    return call('POST', '/accounts', {
        kind: 'user', id, name, email, mobile: phone ?? undefined, password, roleKey: ROLE_KEYS[role], status, organization, branch: branch ?? undefined, platform,
    });
}

/** Status / password change of a login created by createPortalLogin. Logins made before the connection existed are skipped. */
export async function updatePortalLogin(id, patch) {
    if (!adminPortalConnected()) return null;
    try {
        return await call('PATCH', `/accounts/${encodeURIComponent(id)}`, patch);
    } catch (err) {
        if (err.status === 404) return null;
        throw err;
    }
}
