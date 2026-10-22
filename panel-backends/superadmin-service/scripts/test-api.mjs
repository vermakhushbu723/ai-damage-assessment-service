// End-to-end API test: starts its own server on a throwaway database
// (nothing touches superadmin.db), exercises every endpoint, then deletes
// the temp database.  Run: npm run test:api
import { spawn } from 'node:child_process';
import http from 'node:http';
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
        CLAIMS_INGEST_KEY: 'test-ingest-key',
        APP_VERSION: 'v2.4.1',
        LATEST_VERSION: 'v2.4.2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const INGEST_KEY = 'test-ingest-key';
// Stand-in for an external API, used by the integration "Test" checks.
let lastMockAuth = null;
const mock = http.createServer((req, res) => {
    lastMockAuth = req.headers.authorization ?? null;
    if (req.url === '/slow') return setTimeout(() => res.end('ok'), 2300);
    if (req.url === '/boom') { res.statusCode = 500; return res.end('err'); }
    return res.end('ok');
});
await new Promise((r) => mock.listen(8042, '127.0.0.1', r));
const mockUrl = 'http://127.0.0.1:8042';

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

    // ================= Service configuration, reports and system =================

    // ---------------- Service models ----------------
    const smBody = { name: 'Motor Claims', serviceType: 'Claims', applicableFor: 'Motor', description: 'Own damage', sla: 48, workingHours: '09:00 AM - 06:00 PM', escalationAfter: '24 Hours', escalationTo: 'Senior Claims Manager', priority: 'High' };
    r = await call('GET', '/service-models', { token: master });
    check('service models: start empty', r.status === 200 && r.data.length === 0);
    r = await call('POST', '/service-models', { token: master, body: smBody });
    check('service models: create -> SM-101 Active', r.status === 201 && r.data.id === 'SM-101' && r.data.status === 'Active' && r.data.sla === 48, JSON.stringify(r.data));
    r = await call('POST', '/service-models', { token: master, body: { ...smBody, name: 'motor claims' } });
    check('service models: duplicate name -> 409', r.status === 409);
    r = await call('POST', '/service-models', { token: master, body: { ...smBody, name: 'Bad Hours', workingHours: '9 to 6' } });
    check('service models: bad working hours -> 400', r.status === 400);
    r = await call('POST', '/service-models', { token: master, body: { ...smBody, name: 'No Type', serviceType: 'Gold' } });
    check('service models: bad service type -> 400', r.status === 400);
    r = await call('PATCH', '/service-models/SM-101', { token: master, body: { status: 'Suspended', sla: 72 } });
    check('service models: update status + SLA', r.status === 200 && r.data.status === 'Suspended' && r.data.sla === 72);
    r = await call('GET', '/service-models/SM-999', { token: master });
    check('service models: unknown id -> 404', r.status === 404);

    // ---------------- Workflows ----------------
    r = await call('GET', '/workflows', { token: master });
    check('workflows: master gets both modes', r.status === 200 && r.data.saas.stages.length === 10 && r.data.serviceProvider.stages.length === 7 && r.data.options.channels.length === 5);
    check('workflows: live stats', r.data.saas.stats.stages === 10 && r.data.saas.stats.users === 2 && r.data.serviceProvider.stats.users === 2, JSON.stringify(r.data.saas.stats));
    const saasRules = r.data.saas.rules;
    r = await call('GET', '/workflows', { token: sp });
    check('workflows: SP admin only sees SP workflow', r.status === 200 && !r.data.saas && r.data.serviceProvider);
    r = await call('PATCH', '/workflows/saas', { token: sp, body: { autoRoles: ['TCT'] } });
    check('workflows: SP admin cannot change SaaS workflow -> 403', r.status === 403);
    const rules = saasRules.map((x) => (x.stage === 'Approval' ? { ...x, enabled: false, view: true } : x));
    r = await call('PATCH', '/workflows/saas', { token: master, body: { rules } });
    const approval = r.data.rules.find((x) => x.stage === 'Approval');
    check('workflows: save rules (disabled stage loses rights)', r.status === 200 && approval.enabled === false && approval.view === false && r.data.stats.stages === 9);
    r = await call('PATCH', '/workflows/saas', { token: master, body: { rules: rules.slice(1) } });
    check('workflows: incomplete rules -> 400', r.status === 400);
    r = await call('PATCH', '/workflows/saas', { token: master, body: { overview: { insurer: 'Test General Insurance', adminProfile: 'Regional Manager' } } });
    check('workflows: business model saved', r.status === 200 && r.data.overview.insurer === 'Test General Insurance' && r.data.overview.adminProfile === 'Regional Manager');
    r = await call('PATCH', '/workflows/saas', { token: master, body: { overview: { insurer: 'Nobody Ltd' } } });
    check('workflows: unknown insurer -> 400', r.status === 400);
    r = await call('PATCH', '/workflows/saas', { token: master, body: { overview: { feeBillModel: 'Manual entry' } } });
    check('workflows: SaaS rejects fee bill model', r.status === 400);
    r = await call('PATCH', '/workflows/serviceProvider', { token: master, body: { autoRoles: ['TCT', 'Sr TCT', 'Claim Handler'] } });
    check('workflows: auto roles saved', r.status === 200 && r.data.autoRoles.length === 3);
    r = await call('PATCH', '/workflows/serviceProvider', { token: master, body: { autoRoles: ['CEO'] } });
    check('workflows: unknown auto role -> 400', r.status === 400);
    r = await call('POST', '/workflows/serviceProvider/triggers', { token: master, body: { trigger: 'Fee Bill Raised', stage: 'Fee Bill', recipient: 'Insurer', channels: ['email', 'SMS'] } });
    const trig = r.data.triggers?.find((t) => t.trigger === 'Fee Bill Raised');
    check('workflows: add trigger', r.status === 201 && trig && trig.channels === 'email+SMS' && trig.status === 'Active');
    r = await call('POST', '/workflows/serviceProvider/triggers', { token: master, body: { trigger: 'X', stage: 'Approval', recipient: 'Y', channels: ['email'] } });
    check('workflows: trigger stage must exist in mode', r.status === 400);
    r = await call('PATCH', `/workflows/serviceProvider/triggers/${trig.id}`, { token: master, body: { status: 'Inactive', channels: ['Whatsapp'] } });
    check('workflows: edit trigger', r.status === 200 && r.data.triggers.find((t) => t.id === trig.id).status === 'Inactive');
    r = await call('POST', '/workflows/serviceProvider/activate', { token: master });
    check('workflows: activate', r.status === 200 && r.data.activatedAt && r.data.activatedBy);

    // ---------------- Claims ----------------
    r = await call('POST', '/claims/ingest', { body: { claims: [{ id: 'X', customer: 'A', status: 'Survey', intimationDate: '2026-10-01' }] } });
    check('claims ingest: no key -> 401', r.status === 401);
    r = await fetch(`${BASE}/claims/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': 'wrong' }, body: '{}' });
    check('claims ingest: wrong key -> 401', r.status === 401);
    const ingest = async (claims) => {
        const res = await fetch(`${BASE}/claims/ingest`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Service-Key': INGEST_KEY, 'X-Service-Name': 'test' }, body: JSON.stringify({ claims }) });
        return { status: res.status, data: await res.json() };
    };
    const today = new Date().toISOString();
    r = await ingest([
        { id: 'CLM-1', organizationId: org1.id, customer: 'Rohit Sharma', claimType: 'Motor Vehicle', handler: 'Rajive', amount: 85000, slaDays: 2, status: 'Survey', intimationDate: today, region: 'North', branch: 'Mumbai HQ' },
        { id: 'CLM-2', organizationId: org1.id, customer: 'Priya Patel', amount: 120000, status: 'Settled', intimationDate: today, settledAt: today, region: 'West' },
        { id: 'CLM-3', organizationId: org2.id, customer: 'Amit Kumar', amount: 40000, status: 'AI ILA', intimationDate: today, region: 'South' },
    ]);
    check('claims ingest: service key creates 3', r.status === 201 && r.data.created === 3, JSON.stringify(r.data));
    r = await ingest([{ id: 'CLM-1', organizationId: org1.id, customer: 'Rohit Sharma', amount: 90000, status: 'FLA', intimationDate: today }]);
    check('claims ingest: same id updates', r.status === 201 && r.data.updated === 1);
    r = await ingest([{ id: 'CLM-9', customer: 'Bad', status: 'Lost', intimationDate: today }]);
    check('claims ingest: invalid status -> 400', r.status === 400 && /Claim #1/.test(r.data.detail));
    r = await ingest([{ id: 'CLM-9', organizationId: 'ORG-9999', customer: 'Bad', status: 'Survey', intimationDate: today }]);
    check('claims ingest: unknown organization -> 400', r.status === 400);
    r = await call('POST', '/claims/ingest', { token: saas, body: { claims: [{ id: 'CLM-8', customer: 'Z', status: 'Survey', intimationDate: today }] } });
    check('claims ingest: non-master token -> 403', r.status === 403);
    r = await call('GET', '/claims', { token: master });
    check('claims: master sees all 3', r.status === 200 && r.data.length === 3 && r.data.find((c) => c.id === 'CLM-1').status === 'FLA' && r.data.find((c) => c.id === 'CLM-1').organization === org1.name);
    r = await call('GET', '/claims', { token: sp });
    check('claims: SP admin sees only SP claims', r.data.length === 1 && r.data[0].id === 'CLM-3');
    r = await call('GET', '/claims/CLM-1', { token: sp });
    check('claims: SP admin cannot open SaaS claim -> 404', r.status === 404);
    r = await call('GET', `/organizations/${org1.id}`, { token: master });
    check('orgs: claims count is live', r.data.claims === 2);

    // ---------------- Data Download ----------------
    r = await call('POST', '/downloads', { token: master, body: { dataType: 'Claims', format: 'csv' } });
    check('downloads: generate claims CSV', r.status === 201 && r.data.rows === 3 && r.data.status === 'Ready' && r.data.fileName.startsWith('Claims_'), JSON.stringify(r.data));
    const dl = r.data;
    let res = await fetch(`${BASE}/downloads/${dl.id}/file`, { headers: { Authorization: `Bearer ${master}` } });
    const csv = await res.text();
    check('downloads: file is real CSV', res.status === 200 && res.headers.get('content-type').includes('text/csv') && csv.includes('Claim ID') && csv.includes('CLM-2') && csv.split('\r\n').filter(Boolean).length === 4);
    r = await call('POST', '/downloads', { token: master, body: { dataType: 'Payments', format: 'excel' } });
    check('downloads: payments = settled claims only', r.status === 201 && r.data.rows === 1);
    r = await call('POST', '/downloads', { token: master, body: { dataType: 'Users', format: 'csv', organizationId: org2.id } });
    check('downloads: organization filter', r.status === 201 && r.data.rows === 2);
    r = await call('POST', '/downloads', { token: master, body: { dataType: 'Claims', format: 'csv', from: '2020-01-01', to: '2020-01-31' } });
    check('downloads: empty range -> 422', r.status === 422);
    r = await call('POST', '/downloads', { token: master, body: { dataType: 'Claims', format: 'csv', from: '2026-10-05', to: '2026-10-01' } });
    check('downloads: end before start -> 400', r.status === 400);
    r = await call('POST', '/downloads', { token: master, body: { dataType: 'Secrets', format: 'csv' } });
    check('downloads: unknown data type -> 400', r.status === 400);
    r = await call('POST', '/downloads', { token: sp, body: { dataType: 'Claims', format: 'csv' } });
    check('downloads: SP admin export only has SP claims', r.status === 201 && r.data.rows === 1);
    r = await call('GET', '/downloads', { token: master });
    check('downloads: history newest first', r.status === 200 && r.data.length === 4 && r.data[0].generatedBy);
    await ingest([{ id: 'CLM-4', organizationId: org1.id, customer: '=HYPERLINK("x")', status: 'Survey', intimationDate: today }]);
    r = await call('POST', '/downloads', { token: master, body: { dataType: 'Claims', format: 'csv' } });
    res = await fetch(`${BASE}/downloads/${r.data.id}/file`, { headers: { Authorization: `Bearer ${master}` } });
    check('downloads: formula injection neutralised', (await res.text()).includes(`"'=HYPERLINK(""x"")"`));

    // ---------------- Reports ----------------
    r = await call('GET', '/reports/usage', { token: master });
    const u = r.data;
    check('reports: usage shape', r.status === 200 && u.heatmap.values.length === 6 && u.heatmap.values[0].length === 12 && u.dauMau.length === 9 && u.alertsTrend.length === 9);
    check('reports: sessions counted from real logins', u.sessions.last30 >= 5 && u.dauMau[8].dau >= 3, JSON.stringify(u.sessions));
    check('reports: api requests counted', u.apiRequests.last30 > 50);
    check('reports: module usage from audit trail', u.moduleUsage.some((m) => m.module === 'Organizations' && m.sessions >= 2));
    check('reports: failed actions in alerts trend', u.alertsTrend[8].value >= 3);
    check('reports: storage size', u.storageBytes > 10000);

    // ---------------- Integrations ----------------
    r = await call('GET', '/integrations', { token: master });
    check('integrations: 3, not configured', r.status === 200 && r.data.length === 3 && r.data.every((i) => i.status === 'Not Configured' && !i.endpoint));
    r = await call('POST', '/integrations/policy-los/test', { token: master });
    check('integrations: test without endpoint -> 400', r.status === 400);
    r = await call('PATCH', '/integrations/policy-los', { token: sp, body: { endpoint: `${mockUrl}/ok` } });
    check('integrations: non-master cannot configure -> 403', r.status === 403);
    r = await call('PATCH', '/integrations/policy-los', { token: master, body: { endpoint: 'ftp://x' } });
    check('integrations: non-http endpoint -> 400', r.status === 400);
    r = await call('PATCH', '/integrations/policy-los', { token: master, body: { endpoint: `${mockUrl}/ok`, apiKey: 'secret-key-1', environment: 'UAT' } });
    check('integrations: configure (key hidden)', r.status === 200 && r.data.status === 'Not Tested' && r.data.hasApiKey && !JSON.stringify(r.data).includes('secret-key-1'));
    r = await call('POST', '/integrations/policy-los/test', { token: master });
    check('integrations: test -> Connected + key sent', r.status === 200 && r.data.status === 'Connected' && r.data.responseMs >= 0 && lastMockAuth === 'Bearer secret-key-1', `${r.data.status} ${lastMockAuth}`);
    await call('PATCH', '/integrations/vehicle-rc', { token: master, body: { endpoint: `${mockUrl}/slow` } });
    r = await call('POST', '/integrations/vehicle-rc/test', { token: master });
    check('integrations: slow endpoint -> Warning', r.data.status === 'Warning' && /Slow/.test(r.data.lastError));
    await call('PATCH', '/integrations/comm-gateway', { token: master, body: { endpoint: `${mockUrl}/boom` } });
    r = await call('POST', '/integrations/comm-gateway/test', { token: master });
    check('integrations: 500 -> Failed', r.data.status === 'Failed' && r.data.lastError === 'HTTP 500');
    await call('PATCH', '/integrations/comm-gateway', { token: master, body: { endpoint: 'http://127.0.0.1:1/' } });
    r = await call('POST', '/integrations/comm-gateway/test', { token: master });
    check('integrations: unreachable -> Failed', r.data.status === 'Failed' && r.data.lastError);

    // ---------------- System ----------------
    r = await call('GET', '/system', { token: master });
    check('system: version + first deployment', r.status === 200 && r.data.currentVersion === 'v2.4.1' && r.data.latestVersion === 'v2.4.2' && r.data.upToDate === false && r.data.deployments.length === 1);
    check('system: activity from integration changes', r.data.activity.some((a) => a.module === 'API Integration'));
    r = await call('PATCH', '/system/settings', { token: sp, body: { maintenanceMode: true } });
    check('system: non-master cannot change settings -> 403', r.status === 403);
    r = await call('PATCH', '/system/settings', { token: master, body: { maintenanceApproval: true } });
    r = await call('POST', '/system/update', { token: master });
    check('system: update blocked without maintenance mode', r.status === 400 && /Maintenance Mode/.test(r.data.detail));
    r = await call('PATCH', '/system/settings', { token: master, body: { maintenanceMode: true } });
    check('system: maintenance mode ON logged', r.status === 200 && r.data.maintenanceMode === true && r.data.activity[0].activity === 'Maintenance mode ON');
    r = await call('POST', '/auth/login', { body: { identifier: 'sp@test.in', password: 'Another@123' } });
    check('system: maintenance blocks non-master login -> 503', r.status === 503);
    r = await call('POST', '/auth/login', { body: { identifier: 'master@test.in', password: PW.master } });
    check('system: master can still log in during maintenance', r.status === 200);
    r = await call('POST', '/system/update', { token: master });
    check('system: update to v2.4.2 recorded', r.status === 200 && r.data.currentVersion === 'v2.4.2' && r.data.upToDate && r.data.deployments[0].version === 'v2.4.2');
    r = await call('POST', '/system/update', { token: master });
    check('system: second update says up to date', r.status === 200 && /latest/.test(r.data.message));
    r = await call('PATCH', '/system/settings', { token: master, body: { maintenanceMode: false, configChangeApproval: true } });
    r = await call('PATCH', '/system/settings', { token: master, body: { retention: '3 Years' } });
    check('system: retention change needs approval when enabled', r.data.retention === '3 Years' && r.data.activity[0].activity === 'Change Retention policy to 3 Years' && r.data.activity[0].status === 'Approval Log');
    r = await call('PATCH', '/system/settings', { token: master, body: { retention: '2 Years' } });
    check('system: invalid retention -> 400', r.status === 400);
    const loginsBefore = (await call('GET', '/audit-logs?action=Login', { token: master })).data.length;
    await call('PATCH', '/system/settings', { token: master, body: { auditLogin: false } });
    await call('POST', '/auth/login', { body: { identifier: 'master@test.in', password: PW.master } });
    const loginsAfter = (await call('GET', '/audit-logs?action=Login', { token: master })).data.length;
    check('system: audit login OFF stops recording sign-ins', loginsAfter === loginsBefore);
    await call('PATCH', '/system/settings', { token: master, body: { auditLogin: true } });

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
    mock.close();
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL file briefly */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (/Error|TypeError/.test(serverLog)) console.log('Server log:\n', serverLog);
    process.exit(fail ? 1 : 0);
}
