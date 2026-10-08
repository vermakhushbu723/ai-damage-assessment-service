// End-to-end API test: starts its own server on a throwaway database
// (admin.db is never touched) plus a stand-in external API, exercises every
// endpoint the Admin portal uses, then deletes the temp database.
// Run: npm run test:api
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'admin-service-test-'));
const PORT = 8048;
const MOCK_PORT = 8047;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PW = 'Admin@12345';
const INGEST_KEY = 'test-ingest-key';

const server = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: {
        ...process.env,
        PORT: String(PORT),
        DATABASE_FILE: join(dir, 'test.db'),
        JWT_SECRET: 'test-secret',
        BOOTSTRAP_ADMIN_EMAIL: 'admin@test.in',
        BOOTSTRAP_ADMIN_MOBILE: '9876543210',
        BOOTSTRAP_ADMIN_PASSWORD: PW,
        ORGANIZATION_NAME: 'Test Insurance',
        RESET_LINK_BASE: 'http://localhost/reset-password',
        CLAIMS_INGEST_KEY: INGEST_KEY,
        APP_VERSION: '2.4.1',
        LATEST_VERSION: '2.4.2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

// Stand-in for the external systems (integration tests + Communication Gateway).
const gatewayCalls = [];
let gatewayFails = false;
const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        if (req.url === '/slow') return setTimeout(() => res.end('ok'), 2300);
        if (req.url === '/boom') { res.statusCode = 500; return res.end('err'); }
        if (req.url === '/notify') {
            gatewayCalls.push({ auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
            res.statusCode = gatewayFails ? 503 : 200;
            return res.end('{}');
        }
        return res.end('ok');
    });
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${MOCK_PORT}`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
};

let TOKEN = null;
async function call(method, path, body, { token = TOKEN, headers = {}, raw = false } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
}
const get = (p, o) => call('GET', p, undefined, o);
const post = (p, b, o) => call('POST', p, b ?? {}, o);
const patch = (p, b, o) => call('PATCH', p, b, o);
const put = (p, b, o) => call('PUT', p, b, o);
const del = (p, o) => call('DELETE', p, undefined, o);

async function waitForServer() {
    for (let i = 0; i < 150; i++) {
        try {
            if ((await fetch(`${BASE}/health`)).ok) return;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`Server did not start:\n${serverLog}`);
}

const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const userBody = (o = {}) => ({
    accountType: 'Internal', roleKey: 'claim-handler', reportingManagerId: 'ADMIN', name: 'Ajay Sharma', employeeId: 'EMP001',
    email: 'ajay@test.in', contact: '+91 9812345678', altContact: '9812345679', department: 'Claims', dateOfJoining: '2026-04-05',
    city: 'Mumbai', state: 'Maharashtra', region: 'West Region', country: 'India', pinCode: '400001', profileImage: IMG,
    zones: ['West'], platform: 'web', status: 'Active', effectiveFrom: '2026-04-05', userId: 'ajay.s', tempPassword: 'Temp@1234',
    extra: { city: 'Mumbai', state: 'Maharashtra', designation: 'Claim Handler' },
    ...o,
});

try {
    await waitForServer();

    // ---------- auth ----------
    check('health', (await get('/health', { token: null })).data?.status === 'ok');
    check('protected route needs a token', (await get('/users', { token: null })).status === 401);
    check('bad token rejected', (await get('/users', { token: 'x.y.z' })).status === 401);
    let r = await post('/auth/login', { identifier: 'admin@test.in', password: 'wrong' }, { token: null });
    check('wrong password -> 401 with attempts left', r.status === 401 && /attempt/.test(r.data?.detail), r.data);
    check('unknown login -> 401', (await post('/auth/login', { identifier: 'nobody@test.in', password: PW }, { token: null })).status === 401);
    check('login needs both fields', (await post('/auth/login', { identifier: '' }, { token: null })).status === 400);
    r = await post('/auth/login', { identifier: 'ADMIN@test.in', password: PW }, { token: null });
    check('login by email (any case)', r.status === 200 && r.data.token && r.data.admin.organization === 'Test Insurance', r.data);
    TOKEN = r.data.token;
    r = await post('/auth/login', { identifier: '+91 98765 43210', password: PW }, { token: null });
    check('login by mobile number', r.status === 200);
    r = await get('/auth/me');
    check('auth/me returns the admin', r.data?.admin?.email === 'admin@test.in' && !('password_hash' in r.data.admin));

    // ---------- defaults ----------
    r = await get('/roles');
    check('11 default roles with permission matrix', r.data.length === 11 && r.data[0].permissions.Dashboard.view === true, r.data.length);
    r = await get('/settings');
    check('settings documents', ['config', 'routing', 'recommendation', 'stageConfig', 'systemUpdate', 'compliance'].every((k) => r.data[k]));
    check('system update versions from env', r.data.systemUpdate.current === '2.4.1' && r.data.systemUpdate.latest === '2.4.2');
    check('no sample people / claims', (await get('/users')).data.length === 0 && (await get('/claims')).data.length === 0 && (await get('/branches')).data.length === 0);
    r = await get('/integrations');
    check('integrations start Not Configured', r.data.length === 3 && r.data.every((i) => i.status === 'Not Configured' && !('apiKey' in i)));
    check('default comm rules / templates / channels', (await get('/comm-rules')).data.length === 11 && (await get('/comm-templates')).data.length === 11 && (await get('/channels')).data.length === 4);

    // ---------- branches ----------
    r = await post('/branches', { id: 'BR-TEST1', name: 'Mumbai HO', organization: 'Test Insurance', class: 'T20', city: 'Mumbai', state: 'Maharashtra', contact: '9812300000', status: 'Active', address: 'Fort, Mumbai' });
    check('create branch keeps the client id', r.status === 201 && r.data.id === 'BR-TEST1', r.data);
    const branchId = r.data.id;
    check('duplicate branch name -> 409', (await post('/branches', { name: 'mumbai ho', organization: 'X', class: 'A1', city: 'Pune', state: 'Maharashtra', contact: '9812300001', status: 'Active', address: 'x' })).status === 409);
    check('branch validation (state)', (await post('/branches', { name: 'B2', organization: 'X', class: 'A1', city: 'Pune', state: 'Mars', contact: '9812300001', status: 'Active', address: 'x' })).status === 400);
    r = await post('/branches', { name: 'Pune Branch', organization: 'Partner Surveyors', class: 'J6', city: 'Pune', state: 'Maharashtra', contact: '9812300002', status: 'Pending', address: 'Pune' });
    check('create branch with server id', r.status === 201 && /^BR-\d+$/.test(r.data.id), r.data);
    r = await patch(`/branches/${branchId}`, { status: 'Suspended' });
    check('update branch status', r.data?.status === 'Suspended');
    await patch(`/branches/${branchId}`, { status: 'Active' });
    check('branch delete not allowed', (await del(`/branches/${branchId}`)).status === 404);

    // ---------- users ----------
    r = await post('/users', userBody({ extra: { ...userBody().extra, branchId } }));
    check('create user -> 201 + temp password once', r.status === 201 && r.data.tempPassword === 'Temp@1234' && /^USR-\d+$/.test(r.data.id), r.data);
    const handler1 = r.data;
    check('internal user gets the insurer org (via branch)', handler1.organization === 'Test Insurance');
    check('phone normalized', handler1.contact === '9812345678');
    check('handler gets capacity 100', handler1.handlerStats?.capacityLimit === 100);
    check('user list never has password fields', !JSON.stringify((await get('/users')).data).includes('password_hash') && !(await get('/users')).data[0].tempPassword);
    check('duplicate email -> 409', (await post('/users', userBody({ userId: 'other.u', employeeId: 'EMP002' }))).status === 409);
    check('duplicate userId -> 409', (await post('/users', userBody({ email: 'x@test.in', employeeId: 'EMP003' }))).status === 409);
    check('duplicate employee id -> 409', (await post('/users', userBody({ email: 'y@test.in', userId: 'yy.user' }))).status === 409);
    check('unknown role -> 400', (await post('/users', userBody({ roleKey: 'nope', email: 'z@test.in', userId: 'zz.user', employeeId: 'EMP004' }))).status === 400);
    check('bad mobile -> 400', (await post('/users', userBody({ contact: '12345', email: 'z@test.in', userId: 'zz.user', employeeId: 'EMP004' }))).status === 400);
    check('same alt contact -> 400', (await post('/users', userBody({ altContact: '9812345678', email: 'z@test.in', userId: 'zz.user', employeeId: 'EMP004' }))).status === 400);
    check('weak temp password -> 400', (await post('/users', userBody({ tempPassword: 'abc', email: 'z@test.in', userId: 'zz.user', employeeId: 'EMP004' }))).status === 400);
    r = await post('/users', userBody({ name: 'Neha Rao', email: 'neha@test.in', userId: 'neha.r', employeeId: 'EMP005', contact: '9822222222', altContact: '9822222223', tempPassword: undefined }));
    check('generated temp password when none sent', r.status === 201 && r.data.tempPassword?.length >= 8, r.data);
    const handler2 = r.data;
    r = await post('/users', userBody({ roleKey: 'call-center', name: 'Karan M', email: 'karan@test.in', userId: 'karan.m', employeeId: 'EMP006', contact: '9833333333', altContact: '9833333334', accountType: 'External', extra: { agentCode: 'CC-1001', shift: 'General (09:00 - 18:00)', languages: ['English'], skills: ['General'] } }));
    check('external call-center user', r.status === 201 && r.data.organization === 'External Partner' && r.data.extra.agentCode === 'CC-1001', r.data);
    const agent = r.data;
    check('duplicate agent code -> 409', (await post('/users', userBody({ roleKey: 'call-center', email: 'k2@test.in', userId: 'karan.2', employeeId: 'EMP007', contact: '9833333335', altContact: '9833333336', extra: { agentCode: 'CC-1001' } }))).status === 409);
    r = await patch(`/users/${handler1.id}`, { city: 'Thane', reportingManagerId: handler2.id });
    check('modify user', r.data?.city === 'Thane' && r.data.reportingManagerId === handler2.id);
    check('cannot report to self', (await patch(`/users/${handler1.id}`, { reportingManagerId: handler1.id })).status === 400);
    check('cannot clear a required field', (await patch(`/users/${handler1.id}`, { email: null })).status === 400);
    r = await patch(`/users/${handler1.id}`, { handlerStats: { capacityLimit: 40 } });
    check('capacity limit via handlerStats', r.data?.handlerStats?.capacityLimit === 40, r.data?.handlerStats);
    check('modify keeps the uniqueness rule', (await patch(`/users/${handler2.id}`, { email: 'ajay@test.in' })).status === 409);
    check('get one user (with profile image)', (await get(`/users/${handler1.id}`)).data?.profileImage === IMG);
    r = (await get('/users')).data.find((u) => u.id === handler1.id);
    check('user list leaves images out', !('profileImage' in r) && r.hasProfileImage === true);
    check('unknown user -> 404', (await get('/users/USR-9')).status === 404);

    // ---------- activation ----------
    r = await post('/users/bulk-status', { ids: [handler2.id, agent.id], status: 'Suspended' });
    check('bulk status', r.data?.updated === 2 && r.data.users.every((u) => u.status === 'Suspended'));
    check('bulk status validates status', (await post('/users/bulk-status', { ids: [agent.id], status: 'Gone' })).status === 400);
    check('bulk status validates ids', (await post('/users/bulk-status', { ids: ['USR-0'], status: 'Active' })).status === 400);

    // ---------- password reset ----------
    check('verify: wrong email', (await post('/users/verify', { userId: 'ajay.s', email: 'no@test.in', contact: '9812345678' })).status === 400);
    check('verify: wrong phone', (await post('/users/verify', { userId: 'ajay.s', email: 'ajay@test.in', contact: '9000000000' })).status === 400);
    check('verify: unknown user -> 404', (await post('/users/verify', { userId: 'ghost', email: 'a@b.in', contact: '9812345678' })).status === 404);
    check('verify: suspended user blocked', (await post('/users/verify', { userId: 'neha.r', email: 'neha@test.in', contact: '9822222222' })).status === 400);
    r = await post('/users/verify', { userId: 'AJAY.S', email: 'Ajay@Test.in', contact: '+91 98123 45678' });
    check('verify ok (case / format insensitive)', r.status === 200 && r.data.id === handler1.id, r.data);
    r = await post(`/users/${handler1.id}/reset-link`);
    check('reset link returned (no mailer)', r.status === 200 && r.data.link.startsWith('http://localhost/reset-password?token=') && r.data.emailSent === false, r.data);
    const token = new URL(r.data.link).searchParams.get('token');
    r = await get(`/password-reset/${token}`, { token: null });
    check('public: reset link is valid', r.status === 200 && r.data.userId === 'ajay.s');
    check('public: weak new password rejected', (await post('/password-reset/confirm', { token, password: 'short' }, { token: null })).status === 400);
    check('public: confirm reset', (await post('/password-reset/confirm', { token, password: 'NewPass@123' }, { token: null })).status === 200);
    check('public: link works only once', (await post('/password-reset/confirm', { token, password: 'NewPass@456' }, { token: null })).status === 400);
    check('public: bogus link', (await get('/password-reset/nope', { token: null })).status === 400);
    r = await post(`/users/${handler1.id}/reset-password`);
    check('manual reset issues temp password', r.status === 200 && r.data.tempPassword.length >= 8 && r.data.user.mustChangePassword === true);
    check('manual reset blocked for suspended', (await post(`/users/${agent.id}/reset-password`)).status === 400);
    await post('/users/bulk-status', { ids: [handler2.id, agent.id], status: 'Active' });

    // ---------- roles ----------
    r = await post('/roles', { name: 'Senior Surveyor', level: 5, copyFrom: 'tct' });
    check('add role copies permissions', r.status === 201 && r.data.permissions.Dashboard.view === true && r.data.permissions.Dashboard.edit === false, r.data);
    const customRole = r.data.key;
    check('duplicate role name -> 409', (await post('/roles', { name: 'senior surveyor', level: 4 })).status === 409);
    check('role level 1-5', (await post('/roles', { name: 'Odd', level: 9 })).status === 400);
    const perms = (await get('/roles')).data.find((x) => x.key === customRole).permissions;
    perms['Audit Logs'].download = true;
    r = await patch(`/roles/${customRole}`, { permissions: perms });
    check('save permission matrix', r.data?.permissions['Audit Logs'].download === true);
    check('unknown permission module rejected', (await patch(`/roles/${customRole}`, { permissions: { Nope: { view: true } } })).status === 400);
    check('users count per role', (await get('/roles')).data.find((x) => x.key === 'claim-handler').users === 2);
    check('built-in role cannot be removed', (await del('/roles/tct')).status === 400);
    check('role in use cannot be removed', (await del('/roles/claim-handler')).status === 400);
    check('remove unused custom role', (await del(`/roles/${customRole}`)).status === 200);

    // ---------- templates / communication ----------
    r = await post('/document-templates', { id: 'TPL-ABC', name: 'Salvage Letter', category: 'Claims', status: 'Active', body: 'Dear {{insured_name}}, salvage for {{claim_no}} is ready.', branchIds: [branchId] });
    check('create document template', r.status === 201 && r.data.version === '1.0');
    check('template branches must exist', (await post('/document-templates', { name: 'X', category: 'Claims', status: 'Active', body: 'x'.repeat(25), branchIds: ['BR-NOPE'] })).status === 400);
    check('template content min length', (await post('/document-templates', { name: 'X', category: 'Claims', status: 'Active', body: 'short' })).status === 400);
    r = await patch('/document-templates/TPL-ABC', { version: '1.1', body: 'Dear {{insured_name}}, updated salvage letter.' });
    check('edit template bumps version', r.data?.version === '1.1');
    r = await post('/comm-rules', { stage: 'FLA', trigger: 'Salvage Approved', template: 'Salvage Letter', recipients: ['Insured'], channels: ['Email'], initialSend: 'Immediately', reminder: '--', status: 'Active' });
    check('create comm rule', r.status === 201);
    check('comm rule rejects unknown channel', (await post('/comm-rules', { stage: 'FLA', trigger: 'x', template: 'y', recipients: ['Insured'], channels: ['Fax'], initialSend: 'Immediately', reminder: '--', status: 'Active' })).status === 400);
    check('comm rule needs a recipient', (await post('/comm-rules', { stage: 'FLA', trigger: 'x', template: 'y', recipients: [], channels: ['SMS'], initialSend: 'Immediately', reminder: '--', status: 'Active' })).status === 400);
    check('delete comm rule', (await del(`/comm-rules/${r.data.id}`)).status === 200);
    r = await patch('/channels/CH-SMS', { enabled: false });
    check('toggle channel', r.data?.enabled === false);
    check('test on a switched-off channel -> 409', (await post('/channels/CH-SMS/test')).status === 409);
    await patch('/channels/CH-SMS', { enabled: true });
    r = await post('/channels/CH-SMS/test');
    check('send test without gateway -> 502 + logged as Failed', r.status === 502 && /not configured/i.test(r.data.detail), r.data);

    // ---------- integrations ----------
    check('integration endpoint must be a URL', (await patch('/integrations/INT-3', { endpoint: 'not a url', env: 'Production' })).status === 400);
    r = await patch('/integrations/INT-3', { endpoint: `${mockUrl}/notify`, env: 'UAT', type: 'Gateway', apiKey: 'gw-key' });
    check('configure gateway (key never returned)', r.data?.status === 'Not Tested' && r.data.hasApiKey === true && !('apiKey' in r.data), r.data);
    r = await post('/integrations/INT-3/test');
    check('test integration -> Connected', r.data?.status === 'Connected' && typeof r.data.responseSec === 'number', r.data);
    await patch('/integrations/INT-1', { endpoint: `${mockUrl}/boom` });
    check('test 5xx -> Failed', (await post('/integrations/INT-1/test')).data?.status === 'Failed');
    await patch('/integrations/INT-1', { endpoint: `${mockUrl}/slow` });
    check('test slow -> Warning', (await post('/integrations/INT-1/test')).data?.status === 'Warning');
    check('test unconfigured -> 400', (await post('/integrations/INT-2/test')).status === 400);
    r = await post('/channels/CH-EMAIL/test');
    check('send test through gateway', r.status === 200 && r.data.sentToday === 1 && gatewayCalls.at(-1)?.auth === 'Bearer gw-key', r.data);

    // ---------- claims ingest ----------
    check('ingest needs key or admin', (await post('/claims/ingest', { claims: [] }, { token: null })).status === 401);
    check('ingest wrong key', (await post('/claims/ingest', { claims: [{ id: 'C1' }] }, { token: null, headers: { 'X-Service-Key': 'nope' } })).status === 401);
    const claims = Array.from({ length: 6 }, (_, i) => ({
        id: `CLM-${1000 + i}`, customer: `Customer ${i}`, type: 'Motor Vehicle', handlerId: handler1.id, amount: 30000 + i * 10000, slaDays: 2,
        stage: i < 4 ? 'Survey' : 'Settled', branchId, region: 'West', intimatedAt: new Date(Date.now() - i * 86400000).toISOString(), vehicleNo: `MH 01 AB ${1000 + i}`, tatMinutes: 100 + i * 10,
    }));
    r = await post('/claims/ingest', {
        claims,
        triggers: [{ id: 'TRG-1', claim: 'CLM-1000', trigger: 'Duplicate document', score: 50, route: 'Audit', reviewer: 'Sr TCT', status: 'Open' }],
        commLogs: [{ id: 'LOG-1', claim: 'CLM-1000', communication: 'Documents Pending', recipient: 'Customer 0', to: 'c0@test.in', channel: 'Whats App', status: 'Failed', message: 'Please upload documents' }],
    }, { token: null, headers: { 'X-Service-Key': INGEST_KEY } });
    check('ingest with service key', r.status === 200 && r.data.claims.created === 6 && r.data.triggers.created === 1 && r.data.commLogs.created === 1, r.data);
    check('ingest validates stage', (await post('/claims/ingest', { claims: [{ id: 'CLM-X', stage: 'Lost' }] })).status === 400);
    check('ingest new claim needs stage', (await post('/claims/ingest', { claims: [{ id: 'CLM-Y' }] })).status === 400);
    r = await post('/claims/ingest', { claims: [{ id: 'CLM-1000', stage: 'FLA' }] });
    check('ingest updates by id (admin token)', r.data?.claims.updated === 1);
    r = await get('/claims');
    const c1000 = r.data.find((c) => c.id === 'CLM-1000');
    check('claims list resolves handler + branch names', r.data.length === 6 && c1000.handler === 'Ajay Sharma' && c1000.branch === 'Mumbai HO' && c1000.stage === 'FLA' && c1000.customer === 'Customer 0', c1000);
    r = await get(`/users/${handler1.id}`);
    check('handler load from claims', r.data.handlerStats.totalClaims === 6 && r.data.handlerStats.inProgress === 4 && r.data.handlerStats.completed === 2, r.data.handlerStats);
    check('recommendation avg TAT from claims', (await get('/settings/recommendation')).data.stats.avgTatMin === 125);

    // ---------- reassign ----------
    check('reassign: more than open -> 400', (await post('/claims/reassign', { fromHandlerId: handler1.id, toHandlerId: handler2.id, count: 9 })).status === 400);
    check('reassign: to non-handler -> 400', (await post('/claims/reassign', { fromHandlerId: handler1.id, toHandlerId: agent.id, count: 1 })).status === 400);
    r = await post('/claims/reassign', { fromHandlerId: handler1.id, toHandlerId: handler2.id, count: 2 });
    check('reassign moves oldest open claims', r.data?.moved === 2 && r.data.from.handlerStats.inProgress === 2 && r.data.to.handlerStats.inProgress === 2, r.data);

    // ---------- triggers / comm logs ----------
    r = await patch('/triggers/TRG-1', { status: 'Under review' });
    check('trigger status change', r.data?.status === 'Under review');
    check('trigger status validated', (await patch('/triggers/TRG-1', { status: 'Lost' })).status === 400);
    check('trigger score not editable', (await patch('/triggers/TRG-1', { score: 1 })).data?.score === 50);
    r = await post('/comm-logs/LOG-1/retry');
    check('retry failed message via gateway', r.data?.status === 'Delivered' && gatewayCalls.at(-1)?.body?.to === 'c0@test.in', r.data);
    check('retry delivered message -> 409', (await post('/comm-logs/LOG-1/retry')).status === 409);
    gatewayFails = true;
    r = await post('/channels/CH-EMAIL/test');
    check('gateway error -> 502', r.status === 502 && /503/.test(r.data.detail), r.data);
    gatewayFails = false;
    check('comm log list', (await get('/comm-logs')).data.length >= 4);

    // ---------- fraud / approval / authority ----------
    r = await post('/fraud-rules', { id: 'FR-NEW', rule: 'Night claim', stage: 'Intimation', severity: 'Low', score: 10, condition: 'Reported 00-05h', action: 'Log', pending: true });
    check('create fraud rule as draft', r.status === 201 && r.data.pending === true && r.data.active === true);
    r = await patch('/fraud-rules/FR-NEW', { pending: null });
    check('publish clears draft flag', r.data && !r.data.pending, r.data);
    check('fraud score max 100', (await patch('/fraud-rules/FR-NEW', { score: 500 })).status === 400);
    r = await post('/authority-matrix', { id: 'AU-NEW', role: 'Sr. Surveyor', motorOD: '1L', fire: '--', other: '50K' });
    check('authority row add', r.status === 201);
    check('authority row remove', (await del('/authority-matrix/AU-NEW')).status === 200);
    r = await post('/approval-history', { id: 'AH-1', rule: 'ILA Amount Threshold', changedBy: 'Hacker', status: 'Published' });
    check('approval history stamped by server', r.data?.changedBy === 'Admin' && r.data.date);
    check('approval history is append-only', (await patch('/approval-history/AH-1', { rule: 'x' })).status === 404);

    // ---------- settings documents ----------
    const settings = (await get('/settings')).data;
    const cfg = settings.config;
    cfg.claimFlow.autoApproval = true;
    cfg.journey.enabled.saas.Intimation = false;
    cfg.approvalRules[0].enabled = false;
    r = await put('/settings/config', cfg);
    check('save dashboard config', r.data?.claimFlow.autoApproval === true && r.data.approvalRules[0].enabled === false);
    check('Intimation stage always on', r.data?.journey.enabled.saas.Intimation === true);
    check('config: bad approval action', (await put('/settings/config', { ...cfg, approvalRules: [{ ...cfg.approvalRules[0], action: 'Explode' }] })).status === 400);
    check('config: switch must be boolean', (await put('/settings/config', { ...cfg, claimFlow: { recommendationEngine: 'yes', autoApproval: true } })).status === 400);
    const routing = settings.routing;
    routing.matrix[0].score = '45';
    r = await put('/settings/routing', routing);
    check('save routing matrix (stats ignored)', r.data?.matrix[0].score === '45' && r.data.stats.autoRouted === 0);
    check('routing score format', (await put('/settings/routing', { ...routing, matrix: [{ ...routing.matrix[0], score: 'high' }] })).status === 400);
    const stage = settings.stageConfig;
    stage.stages.push({ id: 'ST-NEW', stage: 'Salvage', owner: 'Claim Handler', tat: '04 Hrs', rule: 'Salvage approved', active: true });
    check('add claim stage', (await put('/settings/stageConfig', stage)).data?.stages.length === 11);
    check('duplicate stage name rejected', (await put('/settings/stageConfig', { ...stage, stages: [...stage.stages, { ...stage.stages[0], id: 'ST-DUP' }] })).status === 400);
    const rec = settings.recommendation;
    rec.payValidation.Workshop[0].on = false;
    check('save recommendation engine', (await put('/settings/recommendation', rec)).data?.payValidation.Workshop[0].on === false);
    check('unknown setting -> 404', (await put('/settings/nope', {})).status === 404);

    // ---------- system ----------
    r = await put('/settings/systemUpdate', { ...settings.systemUpdate, maintenanceApproval: true, current: '9.9.9' });
    check('system switches saved, versions not writable', r.data?.maintenanceApproval === true && r.data.current === '2.4.1');
    check('update blocked while approval required', (await post('/system/update')).status === 400);
    await put('/settings/systemUpdate', { ...settings.systemUpdate, maintenanceApproval: false });
    r = await post('/system/update');
    check('update to latest records a deployment', r.data?.current === '2.4.2' && r.data.deployments[0].by === 'Admin' && r.data.deployments.length === 2, r.data);
    check('already latest -> 400', (await post('/system/update')).status === 400);
    r = await put('/settings/compliance', { auditLogin: true, retention: '5 Years', inputLogging: true, configApproval: false });
    check('save compliance', r.data?.retention === '5 Years');
    check('compliance retention validated', (await put('/settings/compliance', { auditLogin: true, retention: 'Forever', inputLogging: true, configApproval: false })).status === 400);
    r = await post('/compliance-log', { activity: 'Change Retention policy', module: 'Compilance', user: 'Someone else' });
    check('compliance log stamped by server', r.status === 201 && r.data.user === 'Admin' && r.data.at);

    // ---------- changes / audit ----------
    r = await post('/changes', { module: 'Claim Flow', change: 'Auto-Approval', oldValue: 'OFF', newValue: 'ON', changedBy: 'Spoof' });
    check('log configuration change (who stamped)', r.status === 201 && r.data.changedBy === 'Admin' && /^CHG-\d+$/.test(r.data.id) && r.data.device, r.data);
    check('long change values shortened', (await post('/changes', { module: 'X', change: 'Y', oldValue: 'a'.repeat(900) })).data?.oldValue.length === 500);
    check('change needs module', (await post('/changes', { change: 'Y' })).status === 400);
    check('changes list newest first', (await get('/changes')).data[0].module === 'X');
    r = await get('/audit-logs');
    const refs = new Set(r.data.map((e) => e.reference));
    check('audit has sign-ins, failed sign-ins and resets', refs.has('Login') && refs.has('Failed Login') && refs.has('Password Reset'), [...refs]);

    // ---------- downloads ----------
    check('download needs format', (await post('/downloads', { types: ['Claims'], from: '2026-01-01', to: '2026-12-31' })).status === 400);
    check('download unknown data set', (await post('/downloads', { format: 'CSV', types: ['Secrets'], from: '2026-01-01', to: '2026-12-31' })).status === 400);
    check('download range order', (await post('/downloads', { format: 'CSV', types: ['Claims'], from: '2026-12-31', to: '2026-01-01' })).status === 400);
    const today = new Date().toISOString().slice(0, 10);
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    r = await post('/downloads', { format: 'CSV', types: ['Claims', 'Users', 'Audit Logs'], from: monthAgo, to: today, region: 'West' });
    check('generate 3 files', r.status === 201 && r.data.length === 3 && r.data[0].status === 'Ready', r.data);
    const claimsFile = r.data.find((d) => d.dataType === 'Claims');
    check('claims export counts rows', claimsFile.rows === 6, claimsFile);
    let f = await call('GET', `/downloads/${claimsFile.id}/file`, undefined, { raw: true });
    check('download CSV file', f.status === 200 && f.text.includes('CLM-1000') && /attachment/.test(f.headers.get('content-disposition')));
    r = await post('/downloads', { format: 'Excel', types: ['Payments'], from: monthAgo, to: today });
    f = await call('GET', `/downloads/${r.data[0].id}/file`, undefined, { raw: true });
    check('Excel file is a spreadsheet', f.text.includes('<Workbook') && f.headers.get('content-type').includes('ms-excel') && r.data[0].fileName.endsWith('.xls'));
    r = await post('/downloads', { format: 'JSON', types: ['Survey'], from: monthAgo, to: today });
    f = await call('GET', `/downloads/${r.data[0].id}/file`, undefined, { raw: true });
    check('JSON file parses', Array.isArray(JSON.parse(f.text)));
    check('download history', (await get('/downloads')).data.length === 5);
    check('unknown download -> 404', (await get('/downloads/DL-1/file')).status === 404);

    // ---------- reports ----------
    r = await get('/reports/usage');
    check('usage report cards measured', r.data.cards.users.value === 3 && r.data.cards.sessions.value >= 2 && r.data.cards.api.value > 10 && r.data.cards.storage.value > 0, r.data.cards);
    check('usage modules from requests', r.data.modules.some((m) => m.module === 'Users & Roles' && m.requests > 0));
    check('heat map 6 x 12', r.data.heatmap.length === 6 && r.data.heatmap.every((d) => d.slots.length === 12));
    check('dau/mau 9 days', r.data.dauMau.length === 9 && r.data.dauMau.at(-1).dau === 1);
    check('organizations counted', r.data.cards.orgs.value === 2, r.data.cards.orgs);

    // ---------- misc ----------
    check('unknown route -> 404', (await get('/nope')).status === 404);
    check('invalid JSON -> 400', (await fetch(`${BASE}/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: '{bad' })).status === 400);
    check('change password: wrong current', (await post('/auth/change-password', { currentPassword: 'x', newPassword: 'Another@123' })).status === 400);
    check('change password', (await post('/auth/change-password', { currentPassword: PW, newPassword: 'Another@123' })).status === 200);
    check('new password works', (await post('/auth/login', { identifier: 'admin@test.in', password: 'Another@123' }, { token: null })).status === 200);
    check('logout', (await post('/auth/logout')).status === 200);

    // Lockout last (it locks the only admin).
    let last;
    for (let i = 0; i < 5; i++) last = await post('/auth/login', { identifier: 'admin@test.in', password: 'bad' }, { token: null });
    check('5 wrong passwords lock the account', /locked/i.test(last.data?.detail), last.data);
    check('locked account -> 423', (await post('/auth/login', { identifier: 'admin@test.in', password: 'Another@123' }, { token: null })).status === 423);
} catch (err) {
    fail++;
    console.error('ERROR', err);
    console.error(serverLog);
} finally {
    server.kill();
    mock.close();
    await new Promise((r) => setTimeout(r, 300));
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* still locked on Windows */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
