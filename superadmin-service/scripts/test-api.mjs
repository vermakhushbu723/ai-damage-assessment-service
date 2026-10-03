// End-to-end API test: starts its own server on a throwaway database
// (nothing touches superadmin.db), exercises every endpoint, then deletes
// the temp database.  Run: npm run test:api
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'superadmin-test-'));
const PORT = 8039;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PW = { master: 'Master@1234', saas: 'Saas@12345', sp: 'Sp@123456' };

const server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
        ...process.env,
        PORT: String(PORT),
        DATABASE_FILE: join(dir, 'test.db'),
        JWT_SECRET: 'test-secret',
        BOOTSTRAP_MASTER_EMAIL: 'master@test.in', BOOTSTRAP_MASTER_PASSWORD: PW.master,
        BOOTSTRAP_SAAS_EMAIL: 'saas@test.in', BOOTSTRAP_SAAS_PASSWORD: PW.saas,
        BOOTSTRAP_SP_EMAIL: 'sp@test.in', BOOTSTRAP_SP_PASSWORD: PW.sp,
        RESET_LINK_BASE: 'http://localhost/reset-password',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -> ${detail}` : ''}`);
};

async function call(method, path, { token, body } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { status: res.status, data };
}

async function waitForServer() {
    for (let i = 0; i < 150; i++) {
        try {
            const r = await fetch(`${BASE}/health`);
            if (r.ok) return;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Server did not start:\n${serverLog}`);
}

const orgBody = (overrides = {}) => ({
    type: 'Insurer',
    serviceModel: 'SaaS',
    idType: 'Working',
    name: 'Test General Insurance',
    plan: 'professional',
    subscriptionStart: '2026-10-01T00:00:00.000Z',
    validityMonths: 12,
    workflow: { mode: 'saas', stages: ['Intimation', 'Settlement'] },
    settings: { billingCycle: 'Monthly', modules: ['Claim Management'] },
    form: { companyName: 'Test General Insurance', officialEmail: 'ops@testgi.in', tempPassword: 'ShouldNotBeStored1' },
    admin: { name: 'Asha Rao', email: 'asha@testgi.in', phone: '+91 98765 43210' },
    ...overrides,
});

try {
    await waitForServer();

    // ---------------- Auth ----------------
    let r = await call('POST', '/auth/login', { body: { identifier: 'master@test.in', password: 'wrong-pass1' } });
    check('login: wrong password -> 401', r.status === 401 && /attempt/.test(r.data.detail), JSON.stringify(r.data));
    r = await call('POST', '/auth/login', { body: { identifier: 'nobody@test.in', password: 'whatever12' } });
    check('login: unknown email -> 401 same message', r.status === 401 && /Invalid email/.test(r.data.detail));
    r = await call('POST', '/auth/login', { body: { identifier: 'MASTER@test.in', password: PW.master } });
    check('login: master (case-insensitive email)', r.status === 200 && r.data.token && r.data.admin.isMaster === true, JSON.stringify(r.data));
    const master = r.data.token;
    check('login: response has permission matrix', r.data.permissions?.Dashboard?.view === true);
    check('login: no password hash leaked', !JSON.stringify(r.data).includes('password'));
    r = await call('POST', '/auth/login', { body: { identifier: 'saas@test.in', password: PW.saas } });
    const saas = r.data.token;
    check('login: saas admin scope', r.status === 200 && r.data.admin.scope === 'saas' && r.data.admin.isMaster === false);
    r = await call('POST', '/auth/login', { body: { identifier: 'sp@test.in', password: PW.sp } });
    const sp = r.data.token;
    check('login: sp admin scope', r.status === 200 && r.data.admin.scope === 'serviceProvider');

    r = await call('GET', '/auth/me', { token: master });
    check('me: returns admin', r.status === 200 && r.data.admin.email === 'master@test.in');
    r = await call('GET', '/organizations');
    check('no token -> 401', r.status === 401);
    r = await call('GET', '/organizations', { token: 'abc.def.ghi' });
    check('bad token -> 401', r.status === 401);

    // ---------------- Plans ----------------
    r = await call('GET', '/plans', { token: master });
    check('plans: 4 default plans', r.status === 200 && r.data.length === 4 && r.data[0].id === 'starter');
    r = await call('PATCH', '/plans/starter', { token: master, body: { price: 1199, features: ['Claim Management', ' ', 'Basic Reports'] } });
    check('plans: edit price + features (blank removed)', r.status === 200 && r.data.price === 1199 && r.data.features.length === 2);
    r = await call('PATCH', '/plans/starter', { token: master, body: { price: -5 } });
    check('plans: negative price rejected', r.status === 400);
    r = await call('PATCH', '/plans/nope', { token: master, body: { price: 5 } });
    check('plans: unknown plan 404', r.status === 404);

    // ---------------- Organizations ----------------
    r = await call('GET', '/organizations', { token: master });
    check('orgs: start empty (no demo data)', r.status === 200 && r.data.length === 0);
    r = await call('POST', '/organizations', { token: master, body: orgBody({ name: '' }) });
    check('orgs: missing name -> 400', r.status === 400 && r.data.errors?.name);
    r = await call('POST', '/organizations', { token: master, body: orgBody({ plan: 'gold' }) });
    check('orgs: unknown plan -> 400', r.status === 400);
    r = await call('POST', '/organizations', { token: master, body: orgBody({ admin: { name: 'X Y', email: 'bad' } }) });
    check('orgs: bad admin email -> 400', r.status === 400);
    r = await call('POST', '/organizations', { token: master, body: orgBody() });
    check('orgs: create SaaS insurer -> 201', r.status === 201 && r.data.organization.id === 'ORG-1001', JSON.stringify(r.data));
    const org1 = r.data.organization;
    const creds = r.data.credentials;
    check('orgs: Active + Working ID + expiry +12 months', org1.status === 'Active' && org1.idType === 'Working' && org1.subscriptionExpiry.startsWith('2027-10-01'));
    check('orgs: credentials returned', creds.loginId === 'ORG-1001-ADM' && creds.password.length >= 8 && creds.email === 'asha@testgi.in');
    check('orgs: temp password stripped from form', !('tempPassword' in org1.form) && org1.form.companyName === 'Test General Insurance');
    check('orgs: admin user counted', org1.users === 1);
    r = await call('POST', '/organizations', { token: master, body: orgBody() });
    check('orgs: duplicate name -> 409', r.status === 409);
    r = await call('POST', '/organizations', { token: master, body: orgBody({ name: 'Swift Surveyors', type: 'Surveyor', serviceModel: 'Service Provider', idType: 'Pilot', admin: { name: 'Ravi K', email: 'ravi@swift.in', password: 'Ravi@12345' } }) });
    check('orgs: create SP surveyor (Pilot, custom password)', r.status === 201 && r.data.credentials.loginId === 'ORG-1002-USR' && r.data.credentials.password === 'Ravi@12345' && r.data.organization.idType === 'Pilot');
    const org2 = r.data.organization;
    r = await call('POST', '/organizations', { token: saas, body: orgBody({ name: 'Should Fail', serviceModel: 'Service Provider' }) });
    check('orgs: saas admin cannot create SP org -> 403', r.status === 403);
    r = await call('GET', '/organizations', { token: saas });
    check('orgs: saas admin sees only SaaS orgs', r.data.length === 1 && r.data[0].id === org1.id);
    r = await call('GET', '/organizations', { token: sp });
    check('orgs: sp admin sees only SP orgs', r.data.length === 1 && r.data[0].id === org2.id);
    r = await call('GET', `/organizations/${org1.id}`, { token: sp });
    check('orgs: sp admin cannot open SaaS org -> 404', r.status === 404);
    r = await call('PATCH', `/organizations/${org1.id}`, { token: master, body: { status: 'Suspended', plan: 'enterprise' } });
    check('orgs: inline status + plan edit', r.status === 200 && r.data.status === 'Suspended' && r.data.plan === 'enterprise');
    r = await call('PATCH', `/organizations/${org1.id}`, { token: master, body: { status: 'Closed' } });
    check('orgs: invalid status -> 400', r.status === 400);
    r = await call('PATCH', `/organizations/${org1.id}`, { token: master, body: { validityMonths: 24, form: { companyName: 'Test General Insurance', tempPassword: 'x' } } });
    check('orgs: profile edit recomputes expiry, strips secrets', r.status === 200 && r.data.subscriptionExpiry.startsWith('2028-10-01') && !('tempPassword' in r.data.form));
    r = await call('PATCH', `/organizations/${org1.id}`, { token: master, body: { status: 'Active' } });

    // ---------------- Plan assign ----------------
    r = await call('POST', '/plans/starter/assign', { token: master, body: { organizationIds: [org1.id, org2.id] } });
    check('plans: assign to 2 orgs', r.status === 200 && r.data.plan.subscribers === 2);
    r = await call('POST', '/plans/starter/assign', { token: saas, body: { organizationIds: [org2.id] } });
    check('plans: saas admin cannot assign SP org', r.status === 400);
    r = await call('POST', '/plans/starter/assign', { token: master, body: { organizationIds: [] } });
    check('plans: assign with no orgs -> 400', r.status === 400);

    // ---------------- Users ----------------
    r = await call('GET', '/users', { token: master });
    check('users: org admins listed (2)', r.status === 200 && r.data.length === 2 && r.data.every((u) => u.organization));
    r = await call('POST', '/users', { token: master, body: { organizationId: org1.id, name: 'Neha Verma', email: 'NEHA@testgi.in', phone: '9812345678', role: 'Claim Handler', branch: 'Mumbai HQ', platform: 'Web', status: 'Pending', password: 'Neha@1234' } });
    check('users: create -> USR-1001', r.status === 201 && r.data.user.id === 'USR-1001' && r.data.user.email === 'neha@testgi.in' && r.data.user.status === 'Pending', JSON.stringify(r.data));
    const neha = r.data.user;
    r = await call('POST', '/users', { token: master, body: { organizationId: org1.id, name: 'No Phone', email: 'np@testgi.in', role: 'Claim Handler' } });
    check('users: missing phone -> 400', r.status === 400);
    r = await call('POST', '/users', { token: master, body: { organizationId: 'ORG-9999', name: 'Ghost', email: 'g@x.in', phone: '9812345670', role: 'TCT' } });
    check('users: unknown org -> 400', r.status === 400);
    r = await call('POST', '/users', { token: sp, body: { organizationId: org1.id, name: 'Cross', email: 'c@x.in', phone: '9812345671', role: 'TCT' } });
    check('users: sp admin cannot add to SaaS org', r.status === 400);
    r = await call('POST', '/users', { token: master, body: { organizationId: org2.id, name: 'Karan Mehta', email: 'karan@swift.in', phone: '9822334455', role: 'Surveyor' } });
    check('users: create with generated password', r.status === 201 && r.data.credentials.password.length >= 8);
    const karan = r.data.user;
    r = await call('GET', '/users', { token: saas });
    check('users: saas admin sees only SaaS org users', r.data.every((u) => u.serviceModel === 'SaaS') && r.data.some((u) => u.id === neha.id) && !r.data.some((u) => u.id === karan.id));
    r = await call('PATCH', `/users/${neha.id}`, { token: master, body: { role: 'TCT', status: 'Active' } });
    check('users: inline role + status edit', r.status === 200 && r.data.role === 'TCT' && r.data.status === 'Active');
    r = await call('PATCH', `/users/${neha.id}`, { token: master, body: { role: 'CEO' } });
    check('users: invalid role -> 400', r.status === 400);
    r = await call('GET', `/organizations/${org1.id}`, { token: master });
    check('orgs: users count follows users table', r.data.users === 2);

    // ---------------- User Activation ----------------
    r = await call('POST', '/users/bulk-status', { token: master, body: { ids: [neha.id, karan.id], status: 'Suspended' } });
    check('activation: bulk suspend 2 users', r.status === 200 && r.data.length === 2 && r.data.every((u) => u.status === 'Suspended'));
    r = await call('POST', '/users/bulk-status', { token: saas, body: { ids: [karan.id], status: 'Active' } });
    check('activation: saas admin cannot touch SP user -> 404', r.status === 404);
    r = await call('PATCH', `/users/${neha.id}`, { token: master, body: { status: 'Active' } });
    check('activation: single activate', r.data.status === 'Active');

    // ---------------- Password Reset ----------------
    r = await call('POST', '/users/verify', { token: master, body: { userId: 'usr-1001', email: 'neha@testgi.in', phone: '+91 98123 45678' } });
    check('reset: verify matches (case-insensitive id, formatted phone)', r.status === 200 && r.data.id === neha.id);
    r = await call('POST', '/users/verify', { token: master, body: { userId: neha.id, email: 'wrong@testgi.in', phone: '9812345678' } });
    check('reset: email mismatch -> 400', r.status === 400 && /email/.test(r.data.detail));
    r = await call('POST', '/users/verify', { token: master, body: { userId: 'USR-4040', email: 'a@b.in', phone: '9812345678' } });
    check('reset: unknown user -> 404', r.status === 404);
    r = await call('POST', `/users/${neha.id}/reset-link`, { token: master });
    check('reset: link generated', r.status === 200 && r.data.link.includes('?token=') && r.data.emailSent === false);
    const token = new URL(r.data.link).searchParams.get('token');
    r = await call('GET', `/password-reset/${token}`);
    check('reset: link valid (public)', r.status === 200 && r.data.userId === neha.id);
    r = await call('POST', '/password-reset/confirm', { body: { token, password: 'short' } });
    check('reset: weak password rejected', r.status === 400);
    r = await call('POST', '/password-reset/confirm', { body: { token, password: 'NewPass@2026' } });
    check('reset: confirm with link', r.status === 200);
    r = await call('POST', '/password-reset/confirm', { body: { token, password: 'NewPass@2027' } });
    check('reset: link is single-use', r.status === 400 && /already been used/.test(r.data.detail));
    r = await call('POST', `/users/${neha.id}/reset-password`, { token: master, body: { password: 'Manual@2026', reason: 'Locked out, verified on phone' } });
    check('reset: manual reset', r.status === 200 && r.data.mustChangePassword === true);
    r = await call('POST', `/users/${neha.id}/reset-password`, { token: master, body: { password: 'Manual@2026' } });
    check('reset: manual reset needs a reason', r.status === 400);

    // ---------------- Roles ----------------
    r = await call('GET', '/roles', { token: master });
    check('roles: 4 system roles + layout', r.status === 200 && r.data.roles.length === 4 && r.data.pages.length === 23);
    r = await call('POST', '/roles', { token: master, body: { name: 'Claims Auditor', copyFrom: 'Super Admin' } });
    check('roles: create copied role', r.status === 201 && r.data.permissions.Dashboard.edit === true);
    r = await call('POST', '/roles', { token: master, body: { name: 'claims auditor' } });
    check('roles: duplicate (case-insensitive) -> 409', r.status === 409);
    r = await call('POST', '/roles', { token: saas, body: { name: 'Saas Role' } });
    check('roles: non-master cannot create -> 403', r.status === 403);
    r = await call('GET', '/roles', { token: master });
    const auditor = r.data.roles.find((x) => x.name === 'Claims Auditor');
    auditor.permissions.Dashboard.edit = false;
    auditor.permissions.Bogus = { view: true };
    r = await call('PUT', '/roles/Claims Auditor/permissions', { token: master, body: { permissions: auditor.permissions } });
    check('roles: save matrix (unknown pages dropped)', r.status === 200 && r.data.permissions.Dashboard.edit === false && !('Bogus' in r.data.permissions));
    const superMatrix = (await call('GET', '/roles', { token: master })).data.roles.find((x) => x.name === 'Super Admin').permissions;
    superMatrix.Dashboard.view = false;
    r = await call('PUT', '/roles/Super Admin/permissions', { token: master, body: { permissions: superMatrix } });
    check('roles: Super Admin must keep View', r.status === 400);

    // ---------------- Admin Users ----------------
    r = await call('GET', '/admin-users', { token: saas });
    check('admins: anyone can list (3 bootstrap)', r.status === 200 && r.data.length === 3);
    r = await call('POST', '/admin-users', { token: saas, body: { name: 'X', email: 'x@y.in', role: 'Support admin' } });
    check('admins: non-master cannot create -> 403', r.status === 403);
    r = await call('POST', '/admin-users', { token: master, body: { name: 'Priya Support', email: 'Priya@test.in', phone: '9900112233', role: 'Support admin', mfa: true, status: 'Active' } });
    check('admins: create -> ADM-104 + temp password', r.status === 201 && r.data.admin.id === 'ADM-104' && r.data.admin.email === 'priya@test.in' && r.data.credentials.password.length >= 8, JSON.stringify(r.data));
    const priyaPw = r.data.credentials.password;
    r = await call('POST', '/admin-users', { token: master, body: { name: 'Dup', email: 'priya@test.in', role: 'Support admin' } });
    check('admins: duplicate email -> 409', r.status === 409);
    r = await call('POST', '/admin-users', { token: master, body: { name: 'Bad Role', email: 'br@test.in', role: 'Pilot' } });
    check('admins: unknown role -> 400', r.status === 400);
    r = await call('POST', '/auth/login', { body: { identifier: '9900112233', password: priyaPw } });
    check('admins: new admin logs in by mobile number', r.status === 200 && r.data.admin.id === 'ADM-104');
    const priya = r.data.token;
    r = await call('PATCH', '/admin-users/ADM-104', { token: master, body: { status: 'Suspended', mfa: false } });
    check('admins: suspend + MFA off', r.status === 200 && r.data.status === 'Suspended' && r.data.mfa === false);
    r = await call('GET', '/auth/me', { token: priya });
    check('admins: suspended admin token stops working', r.status === 401);
    r = await call('POST', '/auth/login', { body: { identifier: 'priya@test.in', password: priyaPw } });
    check('admins: suspended admin cannot log in -> 403', r.status === 403);
    r = await call('PATCH', '/admin-users/ADM-101', { token: master, body: { status: 'Suspended' } });
    check('admins: cannot suspend last master', r.status === 400);
    r = await call('POST', '/admin-users/ADM-104/reset-password', { token: master, body: {} });
    check('admins: reset admin password', r.status === 200 && r.data.password.length >= 8);

    // ---------------- Change password + lockout ----------------
    r = await call('POST', '/auth/change-password', { token: sp, body: { currentPassword: 'nope', newPassword: 'Another@123' } });
    check('change-password: wrong current -> 400', r.status === 400);
    r = await call('POST', '/auth/change-password', { token: sp, body: { currentPassword: PW.sp, newPassword: 'Another@123' } });
    check('change-password: ok', r.status === 200);
    r = await call('POST', '/auth/login', { body: { identifier: 'sp@test.in', password: 'Another@123' } });
    check('change-password: new password works', r.status === 200);
    for (let i = 0; i < 5; i++) r = await call('POST', '/auth/login', { body: { identifier: 'saas@test.in', password: 'Wrong@1234' } });
    check('lockout: 5 wrong passwords lock the account', /locked/i.test(r.data.detail));
    r = await call('POST', '/auth/login', { body: { identifier: 'saas@test.in', password: PW.saas } });
    check('lockout: even the right password is refused while locked', r.status === 423);

    // ---------------- Audit logs ----------------
    r = await call('POST', '/audit-logs', { token: master, body: { action: 'Exported', module: 'Reports', detail: 'Claim report CSV' } });
    check('audit: client entry recorded', r.status === 201);
    r = await call('GET', '/audit-logs', { token: master });
    const logs = r.data;
    check('audit: server recorded actions', r.status === 200 && logs.some((l) => l.module === 'Organizations' && l.action === 'Created') && logs.some((l) => l.action === 'Login' && l.status === 'Failed') && logs[0].action === 'Exported');
    r = await call('GET', '/audit-logs?module=Organizations&action=Created', { token: master });
    check('audit: filters', r.data.length === 2 && r.data.every((l) => l.module === 'Organizations'));
    check('audit: device + ip captured', logs.every((l) => l.device && l.ip));

    // ---------------- Misc ----------------
    r = await fetch(`${BASE}/organizations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${master}` }, body: '{bad json' });
    check('malformed JSON -> 400', r.status === 400);
    r = await call('GET', '/nope', { token: master });
    check('unknown route -> 404 JSON', r.status === 404 && r.data.detail);
} catch (err) {
    fail++;
    console.error('Test run crashed:', err);
} finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL file briefly */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (/Error|TypeError/.test(serverLog)) console.log('Server log:\n', serverLog);
    process.exit(fail ? 1 : 0);
}
