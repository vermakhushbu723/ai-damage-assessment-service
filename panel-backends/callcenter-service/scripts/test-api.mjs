// End-to-end API test of the call-center portal backend. Starts:
//   - admin-service (../admin-service) on a throwaway database -- users are
//     created there exactly like Admin > Create Users does;
//   - callcenter-service on its own throwaway database + uploads folder;
//   - a stand-in for the message gateway and the AI ILA service.
// Then walks one claim through the whole journey and checks every endpoint
// the portal uses. Nothing real (admin.db, callcenter.db) is touched.
// Run: npm run test:api
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const adminRoot = join(root, '..', 'admin-service');
const dir = mkdtempSync(join(tmpdir(), 'callcenter-service-test-'));
const ADMIN_PORT = 8058;
const CC_PORT = 8059;
const MOCK_PORT = 8057;
const ADMIN = `http://127.0.0.1:${ADMIN_PORT}/api/v1`;
const CC = `http://127.0.0.1:${CC_PORT}/api/v1`;
const KEY = 'test-service-key';
const ADMIN_PW = 'Admin@12345';

const logs = { admin: '', cc: '' };
function start(name, cwd, env) {
    const p = spawn(process.execPath, ['src/server.js'], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => { logs[name] += d; });
    p.stderr.on('data', (d) => { logs[name] += d; });
    return p;
}
const admin = start('admin', adminRoot, {
    PORT: String(ADMIN_PORT), DATABASE_FILE: join(dir, 'admin.db'), UPLOADS_DIR: join(dir, 'admin-uploads'), JWT_SECRET: 'admin-secret',
    BOOTSTRAP_ADMIN_EMAIL: 'admin@test.in', BOOTSTRAP_ADMIN_MOBILE: '9876543210', BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PW,
    ORGANIZATION_NAME: 'Test Insurance', CLAIMS_INGEST_KEY: KEY,
});
const cc = start('cc', root, {
    PORT: String(CC_PORT), DATABASE_FILE: join(dir, 'cc.db'), UPLOADS_DIR: join(dir, 'cc-uploads'), JWT_SECRET: 'cc-secret',
    ADMIN_SERVICE_URL: `http://127.0.0.1:${ADMIN_PORT}`, ADMIN_SERVICE_KEY: KEY, USER_CACHE_SECONDS: '0',
    NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${MOCK_PORT}/notify`, AI_SERVICE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    SURVEY_LINK_BASE: 'https://survey.test/s', MAX_UPLOAD_MB: '1', PUBLIC_URL: `http://127.0.0.1:${CC_PORT}`,
});

// Stand-in message gateway + AI service.
const sent = [];
const corrections = [];
let gatewayFails = false;
const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
});
const mock = http.createServer(async (req, res) => {
    const body = await readBody(req);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/notify') {
        sent.push(JSON.parse(body.toString()));
        res.statusCode = gatewayFails ? 502 : 200;
        return res.end('{}');
    }
    if (req.url === '/api/v1/detect') {
        return res.end(JSON.stringify({
            photo_id: `ph-${sent.length}-${body.length}`, model_checkpoint: 'yolo-test-v1', is_placeholder_model: false,
            detections: [
                { part: 'front_bumper', damage_type: 'crack', mask_polygon: [[0.1, 0.6], [0.4, 0.6], [0.4, 0.85], [0.1, 0.85]], confidence: 0.96, mask_area_ratio: 0.1 },
                { part: 'hood', damage_type: 'scratch', mask_polygon: [[0.2, 0.2], [0.6, 0.2], [0.6, 0.35]], confidence: 0.82, mask_area_ratio: 0.05 },
            ],
        }));
    }
    if (req.url === '/api/v1/assess') {
        const { detections } = JSON.parse(body.toString());
        return res.end(JSON.stringify({
            line_items: detections.map((d) => ({ part: d.part, damage_type: d.damage_type, severity: d.damage_type === 'crack' ? 'severe' : 'minor', action: d.damage_type === 'crack' ? 'replace' : 'repair', line_total: d.damage_type === 'crack' ? 48500 : 6800 })),
        }));
    }
    if (req.url === '/api/v1/corrections') {
        corrections.push(JSON.parse(body.toString()));
        return res.end('{}');
    }
    if (req.url === '/api/v1/corrections/stats') return res.end(JSON.stringify({ pending_corrections: corrections.length, volume_threshold: 500, threshold_reached: false }));
    res.statusCode = 404;
    return res.end('{}');
});
await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)}` : ''}`);
};

async function call(base, method, path, body, { token, headers = {}, raw = false, binary } = {}) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(binary ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: binary ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
}
const api = (base, token) => ({
    get: (p, o) => call(base, 'GET', p, undefined, { token, ...o }),
    post: (p, b, o) => call(base, 'POST', p, b ?? {}, { token, ...o }),
    patch: (p, b, o) => call(base, 'PATCH', p, b, { token, ...o }),
    put: (p, b, o) => call(base, 'PUT', p, b, { token, ...o }),
    del: (p, o) => call(base, 'DELETE', p, undefined, { token, ...o }),
    upload: (p, buf, type, name) => call(base, 'PUT', p, undefined, { token, binary: buf, headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) } }),
    raw: (method, p, b) => call(base, method, p, b, { token, raw: true }),
});

async function waitFor(base, name) {
    for (let i = 0; i < 400; i++) {
        try {
            if ((await fetch(`${base}/health`)).ok) return;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`${name} did not start:\n${logs[name]}`);
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const PNG2 = Buffer.concat([PNG, Buffer.from('second-photo')]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
const user = (o) => ({
    accountType: 'Internal', reportingManagerId: 'ADMIN', department: 'Claims', city: 'Noida', state: 'Uttar Pradesh', country: 'India',
    pinCode: '201301', zones: ['North'], platform: 'web', status: 'Active', tempPassword: 'Temp@1234', dateOfJoining: '2018-04-01', extra: {}, ...o,
});
const intimation = (o = {}) => ({
    intimationSource: 'Call Center', receivedBy: 'Ravi Kumar', channelType: 'Phone', callerName: 'Amit Verma', callerContact: '+91 98765 43210',
    relationshipWithInsured: 'Self', vehicleLocation: 'Workshop', insurerName: 'Demo Insurance Co', policyNumber: 'POL1234567890',
    policyType: 'Comprehensive', policyStartDate: '2026-03-15T00:00:00.000Z', policyEndDate: '2027-03-14T00:00:00.000Z', lineOfBusiness: 'Motor',
    product: 'Private Car', registrationNumber: 'dl 01 ab 1234', make: 'Maruti Suzuki', model: 'Swift', manufacturingYear: '2021-01-01T00:00:00.000Z',
    dateOfIncident: '2026-10-20T00:00:00.000Z', incidentArea: 'Sector 62', incidentCity: 'Noida', incidentState: 'Uttar Pradesh', incidentPincode: '201301',
    natureOfLoss: 'Motor', briefDescription: 'Vehicle hit by another vehicle', insuredName: 'Amit Verma', insuredContact: '9876543210',
    insuredEmail: 'amit.verma@test.in', communicationPreference: ['SMS', 'Email'], isVehicleAtWorkshop: ['Yes'], workshopName: 'ABC Motors',
    workshopContactNumber: '9811111111', anyInjury: ['No'], ...o,
});

try {
    await Promise.all([waitFor(ADMIN, 'admin'), waitFor(CC, 'cc')]);
    const A = api(ADMIN, (await call(ADMIN, 'POST', '/auth/login', { identifier: 'admin@test.in', password: ADMIN_PW })).data.token);
    const pub = api(CC);

    // ---------- users are created in the Admin portal ----------
    const mk = async (o) => {
        const r = await A.post('/users', user(o));
        if (r.status !== 201) throw new Error(`create user ${o.userId}: ${JSON.stringify(r.data)}`);
        return r.data;
    };
    const agent = await mk({ roleKey: 'call-center', name: 'Karan Mehta', userId: 'karan.cc', email: 'karan@test.in', employeeId: 'CC01', contact: '9811000001', extra: { agentCode: 'CC-1001' } });
    const h1 = await mk({ roleKey: 'claim-handler', name: 'Rahul Kumar', userId: 'rahul.ch', email: 'rahul@test.in', employeeId: 'CH01', contact: '9811000002', platform: 'both' });
    const h2 = await mk({ roleKey: 'claim-handler', name: 'Suresh Rao', userId: 'suresh.ch', email: 'suresh@test.in', employeeId: 'CH02', contact: '9811000003', city: 'Delhi', state: 'Delhi' });
    const sv = await mk({ roleKey: 'internal-surveyor', name: 'Suresh Sharma', userId: 'suresh.sv', email: 'sv@test.in', employeeId: 'SUR-1001', contact: '9811000004', platform: 'mobile', extra: { bankName: 'HDFC Bank Ltd', accountNo: '502000123456789', ifsc: 'HDFC0001234' } });
    await mk({ roleKey: 'external-surveyor', name: 'Ext Surveyor', userId: 'ext.sv', email: 'ext@test.in', employeeId: 'SUR-2001', contact: '9811000005', platform: 'mobile', city: 'Delhi', state: 'Delhi' });
    await mk({ roleKey: 'state-manager', name: 'Vikram Singh', userId: 'vikram.sm', email: 'vikram@test.in', employeeId: 'SM-1001', contact: '9811000006' });
    await mk({ roleKey: 'claim-handler', name: 'Mobile Only', userId: 'mobile.only', email: 'mo@test.in', employeeId: 'CH09', contact: '9811000007', platform: 'mobile' });
    check('users created in Admin > Create Users', true);

    // ---------- sign-in ----------
    check('health', (await pub.get('/health')).data?.adminServiceConfigured === true);
    check('protected route needs a token', (await pub.get('/dashboard')).status === 401);
    let r = await pub.post('/auth/login', { identifier: 'karan.cc', password: 'wrong' });
    check('wrong password -> 401 with attempts left', r.status === 401 && /attempt/.test(r.data?.detail), r.data);
    check('unknown user -> 401', (await pub.post('/auth/login', { identifier: 'nobody', password: 'Temp@1234' })).status === 401);
    check('surveyor (mobile app role) cannot sign in -> 403', (await pub.post('/auth/login', { identifier: 'suresh.sv', password: 'Temp@1234' })).status === 403);
    check('mobile-only platform cannot sign in -> 403', (await pub.post('/auth/login', { identifier: 'mobile.only', password: 'Temp@1234' })).status === 403);
    r = await pub.post('/auth/login', { identifier: 'KARAN@test.in', password: 'Temp@1234' });
    check('call-center agent signs in (email, any case)', r.status === 200 && r.data.token && r.data.user.roleKey === 'call-center' && r.data.user.mustChangePassword === true, r.data);
    const AG = api(CC, r.data.token);
    check('agent permissions come from the Admin role', r.data.user.permissions['Claim Intimation'].create === true && !r.data.user.permissions['Handler Allocation'].view);
    check('auth/me', (await AG.get('/auth/me')).data?.user?.name === 'Karan Mehta');
    r = await AG.post('/auth/change-password', { currentPassword: 'Temp@1234', newPassword: 'short' });
    check('weak new password -> 400', r.status === 400, r.data);
    r = await AG.post('/auth/change-password', { currentPassword: 'Temp@1234', newPassword: 'Karan@2026' });
    check('change temp password', r.status === 200, r.data);
    check('old password no longer works', (await pub.post('/auth/login', { identifier: 'karan.cc', password: 'Temp@1234' })).status === 401);
    r = await pub.post('/auth/login', { identifier: 'karan.cc', password: 'Karan@2026' });
    check('new password works, must-change cleared', r.status === 200 && r.data.user.mustChangePassword === false, r.data);
    const AG2 = api(CC, r.data.token);
    check('agent cannot open Handler Allocation -> 403', (await AG2.get('/handlers')).status === 403);
    const H = api(CC, (await pub.post('/auth/login', { identifier: 'rahul.ch', password: 'Temp@1234' })).data.token);
    check('claim handler signs in', (await H.get('/auth/me')).data?.user?.roleKey === 'claim-handler');

    // ---------- intimation ----------
    r = await AG2.get('/claims/next-id');
    check('next Assist Claim ID preview', /^BIM-\d{6}-1001$/.test(r.data?.id) && /^CLM-\d{6}-1001$/.test(r.data?.claimNo), r.data);
    r = await AG2.post('/claims', { intimation: { callerName: 'Amit', callerContact: '12345' } });
    check('bad contact number -> 400', r.status === 400, r.data);
    r = await AG2.post('/claims', { intimation: { callerName: 'Amit Verma', insuredName: 'Amit Verma' }, link: { autoReminder: true } });
    check('Save Details -> draft', r.status === 201 && r.data.status === 'Draft' && r.data.stage === 'intimation' && r.data.link.autoReminder === true, r.data);
    const claimId = r.data.id;
    const claimNo = r.data.claimNo;
    check('draft is private to its creator', (await H.get(`/claims/${claimId}`)).status === 404);
    r = await AG2.post(`/claims/${claimId}/submit`);
    check('submit with missing fields -> 400 listing them', r.status === 400 && r.data.missing?.includes('Policy Number'), r.data);
    r = await AG2.patch(`/claims/${claimId}`, { intimation: intimation() });
    check('save draft again', r.status === 200 && r.data.vehicleNo === 'DL 01 AB 1234' && r.data.mobile === '9876543210', r.data);
    r = await AG2.get('/dashboard');
    check('my draft listed on the dashboard', r.data.intimations.rows.some((x) => x.id === claimId && x.status === 'Draft'), r.data?.intimations);

    // survey link (before submit is fine)
    r = await AG2.post(`/claims/${claimId}/survey-link/generate`, {});
    check('Generate Link -> preview url, nothing sent', r.status === 200 && r.data.link.url.includes(r.data.link.token) && !r.data.link.sentAt, r.data);
    const previewToken = r.data.link.token;
    r = await AG2.post(`/claims/${claimId}/survey-link`, { recipients: ['Insured'], sendVia: [], mobile: '9876543210' });
    check('survey link needs a channel', r.status === 400);
    r = await AG2.post(`/claims/${claimId}/survey-link`, { recipients: ['Insured'], sendVia: ['SMS', 'Email'], mobile: '+91 98765 43210', email: 'amit.verma@test.in', autoReminder: true });
    check('survey link sent on 2 channels (tracked public link)', r.status === 200 && r.data.link.dispatch.status === 'Sent' && r.data.link.url.startsWith(`http://127.0.0.1:${CC_PORT}/api/v1/s/`), r.data);
    check('one I-Bima Assist ID per claim (no second IBIMA- number)', r.data.claim.id === claimId && !('uniqueId' in r.data.claim.link), r.data.claim.link);
    check('old unique-id endpoint is gone', (await AG2.post(`/claims/${claimId}/unique-id`)).status === 404);
    check('sending keeps the generated link', r.data.link.token === previewToken);
    const closedToken = r.data.link.token;
    const opened = await fetch(r.data.link.url, { redirect: 'manual' });
    check('survey link opens -> recorded + redirected to the survey page', opened.status === 302 && opened.headers.get('location').startsWith('https://survey.test/s?token='));
    check('gateway received both messages', sent.filter((m) => m.claimNo === claimNo).length === 2 && sent.some((m) => m.channel === 'Email' && m.to === 'amit.verma@test.in'));

    r = await AG2.post(`/claims/${claimId}/submit`, { intimation: intimation() });
    check('submit -> Open, pushed to Admin, handler auto-allocated by the Admin rule', r.status === 200 && r.data.status === 'Open' && r.data.sync.pushedToAdmin && !!r.data.handlerId && r.data.stage === 'surveyor-assignment', r.data);
    const firstHandler = r.data.handlerId;
    check('stage tracker: intimation + handler allocation done', r.data.stages.filter((s) => s.done).map((s) => s.key).join() === 'intimation,handler-allocation', r.data.stages);
    check('submit twice -> 409', (await AG2.post(`/claims/${claimId}/submit`)).status === 409);
    r = await A.get(`/claims/${claimNo}`);
    check('Admin portal has the claim with the same handler', r.status === 200 && r.data.handlerId === firstHandler && r.data.stage === 'Intimation' && r.data.customer === 'Amit Verma', r.data);
    r = await A.get('/comm-logs');
    check('Admin Communication Logs got the survey link messages', Array.isArray(r.data) && r.data.filter((l) => l.claim === claimNo).length >= 2, r.data?.length);
    r = await AG2.get('/dashboard?range=24h');
    check('dashboard counts the new intimation + link', r.data.stats.newIntimations.value === 1 && r.data.stats.linkSent.value === 2 && r.data.stats.totalIntimation.value === 1, r.data.stats);
    check('dashboard: priority filter', (await AG2.get('/dashboard?priority=High')).data.intimations.total === 0);
    const inView = async (view) => (await AG2.get(`/claims?view=${view}`)).data.rows.map((x) => x.id);
    check('My Claims: Total / New Intimations list the claim', (await inView('total')).includes(claimId) && (await inView('new')).includes(claimId));
    check('My Claims: Link Sent lists it with the send time', (await inView('link')).includes(claimId) && !!(await AG2.get('/claims?view=link')).data.rows[0].linkSentAt);
    check('My Claims: allocated claim is not in Pending Allocation', !(await inView('pending')).includes(claimId));
    r = await H.get(`/claims/${claimId}`);
    check('claim header for the handler (fraud from Admin)', r.status === 200 && r.data.fraud.available === true && r.data.claimType === 'Motor OD' && r.data.tat.text.startsWith('0D'), r.data);

    // ---------- handler allocation ----------
    r = await H.get('/handlers');
    check('handler directory from Admin users (web/both handlers incl. load)', r.data.rows.length === 3 && r.data.rows.some((x) => x.currentLoad === '1/100'), r.data.rows);
    check('handler filters', (await H.get('/handlers?city=Delhi')).data.rows.length === 1);
    r = await H.get(`/claims/${claimId}/handler`);
    check('current handler + auto method', r.data.current?.id === firstHandler && /Auto/.test(r.data.current.method), r.data);
    const other = firstHandler === h1.id ? h2 : h1;
    check('reassign needs a reason', (await H.post(`/claims/${claimId}/handler`, { handlerId: other.id })).status === 400);
    r = await H.post(`/claims/${claimId}/handler`, { handlerId: other.id, reason: 'workload', remark: 'supervisor' });
    check('reassign claim', r.status === 200 && r.data.handlerId === other.id, r.data);
    check('Admin portal sees the new handler', (await A.get(`/claims/${claimNo}`)).data.handlerId === other.id);
    check('same handler again -> 409', (await H.post(`/claims/${claimId}/handler`, { handlerId: other.id, reason: 'workload' })).status === 409);

    // ---------- surveyor assignment ----------
    r = await H.get('/surveyors?type=internal');
    check('surveyor directory (internal)', r.data.rows.length === 1 && r.data.rows[0].surveyorId === 'SUR-1001' && r.data.rows[0].experience.endsWith('Years'), r.data);
    check('surveyor search', (await H.get('/surveyors?search=ext')).data.rows.length === 1);
    r = await H.post(`/claims/${claimId}/surveyors`, { surveyType: 'spot', surveyorId: sv.id });
    check('assign spot surveyor (+ SMS to surveyor)', r.status === 201 && r.data.assignments.spot?.surveyorName === 'Suresh Sharma' && sent.some((m) => m.reference === 'survey-spot'), r.data);
    const spotId = r.data.assignments.spot.id;
    r = await H.post(`/claims/${claimId}/surveyors/${spotId}/cancel`);
    check('cancel assignment', r.status === 200 && r.data.assignments.spot === null && r.data.history[0].action === 'Assignment Cancelled', r.data);
    r = await H.post(`/claims/${claimId}/surveyors`, { surveyType: 'final', surveyorId: sv.id });
    check('assign final surveyor', r.status === 201 && r.data.claim.stages.find((s) => s.key === 'surveyor-assignment').done, r.data);

    // ---------- claim details ----------
    r = await H.get(`/claims/${claimId}/details`);
    check('claim details prefilled from the intimation', r.data.values.vehicleRegNo === 'DL 01 AB 1234' && r.data.values.yearOfManufacture === '2021' && r.data.values.rcOwnerName === 'Amit Verma', r.data);
    check('agent cannot open claim details -> 403', (await AG2.get(`/claims/${claimId}/details`)).status === 403);
    check('bad driver contact -> 400', (await H.put(`/claims/${claimId}/details`, { values: { driverContact: '123' } })).status === 400);
    r = await H.put(`/claims/${claimId}/details`, { values: { ...r.data.values, odometer: '45000', bodyType: 'hatchback', driverName: 'Amit Kumar', driverContact: '+91 98765 43210', partsDamage: ['Front Bumper', 'Bonnet'], primaryDriver: 'Yes' } });
    check('driver / loss fields saved (tags list kept)', r.status === 200 && r.data.values.driverContact === '9876543210' && r.data.values.partsDamage.length === 2, r.data);
    check('Save Draft', r.status === 200 && r.data.values.odometer === '45000' && !r.data.claim.stages.find((s) => s.key === 'claim-details').done);
    r = await H.put(`/claims/${claimId}/details`, { values: { ...r.data.values }, complete: true });
    check('Next completes Claim Details', r.data.claim.stage === 'ai-ila', r.data.claim?.stage);
    r = await H.get(`/claims/${claimId}/info`);
    check('Claim Information prefilled (claim, survey, vehicle, insured)', r.data.values.claimNumber === claimNo && r.data.values.finalSurveyorName === 'Suresh Sharma' && r.data.values.registrationNumber === 'DL 01 AB 1234' && r.data.values.driverName === 'Amit Kumar', r.data.values);
    r = await H.put(`/claims/${claimId}/info`, { values: { ...r.data.values, ncbStatus: '20%', investigationRequired: 'No' } });
    check('Claim Information saved', r.status === 200 && r.data.values.ncbStatus === '20%');
    check('agent cannot open Claim Information -> 403', (await AG2.get(`/claims/${claimId}/info`)).status === 403);

    // ---------- documents ----------
    r = await H.get(`/claims/${claimId}/documents`);
    check('documents: 5 required pending', r.data.pending.length === 5 && r.data.types.find((t) => t.type === 'rc').status === 'pending', r.data.pending);
    check('wrong file type -> 400', (await H.upload(`/claims/${claimId}/documents/rc`, Buffer.from('x'), 'text/plain', 'a.txt')).status === 400);
    check('too large -> 413', (await H.upload(`/claims/${claimId}/documents/rc`, Buffer.alloc(1.2 * 1024 * 1024), 'application/pdf', 'big.pdf')).status === 413);
    check('unknown type -> 400', (await H.upload(`/claims/${claimId}/documents/nope`, PDF, 'application/pdf', 'a.pdf')).status === 400);
    r = await H.upload(`/claims/${claimId}/documents/rc`, PDF, 'application/pdf', 'RC copy.pdf');
    check('upload RC', r.status === 201 && r.data.document.name === 'RC copy.pdf' && r.data.types.find((t) => t.type === 'rc').status === 'uploaded', r.data);
    const rcUrl = r.data.document.url;
    r = await H.upload(`/claims/${claimId}/documents/rc`, PDF, 'application/pdf', 'RC new.pdf');
    check('replace RC keeps one current file', r.data.files.filter((f) => f.type === 'rc').length === 1 && r.data.files.find((f) => f.type === 'rc').name === 'RC new.pdf');
    let f = await fetch(`${CC}${rcUrl}`);
    check('signed file link serves the file', f.status === 200 && f.headers.get('content-type') === 'application/pdf');
    f = await fetch(`${CC}${rcUrl.replace(/sig=[^&]+/, 'sig=bad')}`);
    check('tampered file link -> 403', f.status === 403);
    check('process with pending docs -> 400', (await H.post(`/claims/${claimId}/documents/process`)).status === 400);
    for (const [type, name] of [['dl', 'DL.pdf'], ['estimate', 'Estimate.pdf'], ['policy-copy', 'Policy.pdf'], ['claim-form', 'ClaimForm.pdf']]) {
        await H.upload(`/claims/${claimId}/documents/${type}`, PDF, 'application/pdf', name);
    }
    check('pdf as vehicle photo -> 400', (await H.upload(`/claims/${claimId}/documents/vehicle-photos`, PDF, 'application/pdf', 'x.pdf')).status === 400);
    await H.upload(`/claims/${claimId}/documents/vehicle-photos`, PNG, 'image/png', 'front.png');
    await H.upload(`/claims/${claimId}/documents/vehicle-photos`, PNG2, 'image/png', 'rear.png');
    r = await H.upload(`/claims/${claimId}/documents/vehicle-photos`, PNG, 'image/png', 'front-again.png');
    check('vehicle photos keep every file', r.data.files.filter((x) => x.type === 'vehicle-photos').length === 3);
    r = await H.post(`/claims/${claimId}/documents/process`);
    check('Upload & Process ok when complete', r.status === 200 && r.data.pending.length === 0, r.data);
    let dl = await H.raw('GET', `/claims/${claimId}/documents/download.zip`);
    check('Download As Zip File', dl.status === 200 && dl.buf.readUInt32LE(0) === 0x04034b50 && dl.headers.get('content-type') === 'application/zip');
    dl = await H.raw('GET', `/claims/${claimId}/documents/download.pdf`);
    check('Download As PDF (register + photos)', dl.status === 200 && dl.buf.subarray(0, 5).toString() === '%PDF-' && dl.buf.includes(Buffer.from('/Subtype /Image')));
    check('agent can upload on intimation (Claim Intimation create)', (await AG2.upload(`/claims/${claimId}/documents/fir`, PDF, 'application/pdf', 'FIR.pdf')).status === 201);

    // ---------- AI ILA ----------
    r = await H.get(`/claims/${claimId}/ai-ila`);
    check('AI ILA before run', r.data.ai.configured && r.data.ai.status === 'not-run' && r.data.images.length === 3 && r.data.rows.length === 0, r.data.ai);
    r = await H.post(`/claims/${claimId}/ai-ila/run`);
    check('run AI on 3 photos -> 6 rows (detect + assess)', r.status === 200 && r.data.rows.length === 6 && r.data.ai.model === 'yolo-test-v1', r.data?.ai ?? r.data);
    check('rows mapped (Front Bumper, Crack, Severe, Replace, 96%)', r.data.rows[0].part === 'Front Bumper' && r.data.rows[0].damageType === 'Crack' && r.data.rows[0].severity === 'Severe' && r.data.rows[0].action === 'Replace' && r.data.rows[0].confidence === 96 && r.data.rows[0].box?.w === 30, r.data.rows[0]);
    check('insights: duplicate photo found', r.data.insights.rows.find((x) => x.key === 'duplicate').value === '1 Of 3', r.data.insights.rows);
    check('summary total = AI estimate', r.data.summary.total === 3 * (48500 + 6800) && r.data.summary.badge === 'Within Policy', r.data.summary);
    const rows = r.data.rows;
    r = await H.patch(`/claims/${claimId}/ai-ila/items/${rows[5].id}`, { severity: 'Moderate', cost: 7000 });
    check('edit a row counts a correction', r.status === 200 && r.data.corrections === 1 && r.data.rows.find((x) => x.id === rows[5].id).corrected, r.data?.corrections);
    check('invalid value -> 400', (await H.patch(`/claims/${claimId}/ai-ila/items/${rows[0].id}`, { severity: 'Huge' })).status === 400);
    r = await H.post(`/claims/${claimId}/ai-ila/items`, { part: 'Left Door', damageType: 'Dent', severity: 'Minor', action: 'Repair', cost: 3200 });
    check('Add Damages (reviewer row)', r.status === 201 && r.data.rows.some((x) => x.part === 'Left Door' && x.source === 'reviewer'));
    r = await H.post(`/claims/${claimId}/ai-ila/items/merge`, { ids: [rows[1].id, rows[3].id] });
    check('merge two rows', r.status === 200 && r.data.rows.length === 6, r.data?.rows?.length);
    r = await H.del(`/claims/${claimId}/ai-ila/items/${rows[2].id}`);
    check('delete a row (counts as correction)', r.data.rows.length === 5 && r.data.corrections >= 2, r.data?.corrections);
    r = await H.post(`/claims/${claimId}/ai-ila/approve-all`);
    check('Approve All', r.data.rows.every((x) => x.status === 'Approval'));
    r = await H.put(`/claims/${claimId}/ai-ila/note`, { note: 'Hood severity upgraded.' });
    check('save review note', r.data.review.note === 'Hood severity upgraded.' && r.data.review.noteSavedAt);
    r = await H.post(`/claims/${claimId}/ai-ila/report`);
    check('Generate ILA Report', !!r.data.review.reportGeneratedAt);
    let raw = await H.raw('GET', `/claims/${claimId}/ai-ila/report.pdf`);
    check('ILA draft PDF', raw.status === 200 && raw.buf.subarray(0, 5).toString() === '%PDF-');
    raw = await H.raw('GET', `/claims/${claimId}/ai-ila/export.csv`);
    check('Export CSV', raw.status === 200 && raw.buf.toString().split('\n').length === 6);
    r = await H.post(`/claims/${claimId}/ai-ila/decision`, { decision: 'Approved' });
    check('Approve AI -> stage FLA, corrections sent to retraining', r.status === 200 && r.data.claim.stage === 'fla' && corrections.length >= 1 && r.data.review.decision === 'Approved', { stage: r.data?.claim?.stage, corrections: corrections.length });
    check('approved assessment is locked', (await H.patch(`/claims/${claimId}/ai-ila/items/${rows[0].id}`, { cost: 1 })).status === 409);
    check('Admin portal stage AI ILA -> ILA', (await A.get(`/claims/${claimNo}`)).data.stage === 'ILA');

    // ---------- Handler ILA (liability) ----------
    r = await H.get(`/claims/${claimId}/liability`);
    check('liability seeded from approved AI rows', r.status === 200 && r.data.seeded && r.data.parts.length === 5 && r.data.totals.netLiability > 0, r.data?.totals);
    const glass = r.data.parts.length;
    r = await H.post(`/claims/${claimId}/liability/parts`, { part: 'Front Wind Shield', material: 'Glass Fiber', action: 'Replace', allowed: 'Allowed', partPrice: 12000 });
    check('Add Part', r.status === 201 && r.data.parts.length === glass + 1 && r.data.parts.at(-1).depreciationPct === 30, r.data?.parts?.at(-1));
    r = await H.patch(`/claims/${claimId}/liability/parts/${r.data.parts.at(-1).id}`, { allowed: 'Disallowed', remarks: 'Pre-existing' });
    check('disallow a part (not counted)', r.data.parts.at(-1).allowed === 'Disallowed' && r.data.tables.final.rows.at(-1).values[0] === r.data.totals.netLiability);
    check('compulsory excess deducted', r.data.charges.compulsoryExcess === -1000);
    raw = await H.raw('POST', `/claims/${claimId}/liability/report`);
    check('Generate Report -> PDF', raw.status === 200 && raw.buf.subarray(0, 5).toString() === '%PDF-');
    check('payment needs the FLA first', (await H.post(`/claims/${claimId}/payment/submit`)).status === 400);
    r = await H.post(`/claims/${claimId}/liability/submit`);
    check('Handler ILA submitted (FLA step still open)', r.status === 200 && r.data.status === 'Submitted' && (await H.get(`/claims/${claimId}`)).data.stage === 'fla', r.data);
    const handlerNet = r.data.totals.netLiability;
    check('submitted Handler ILA is locked', (await H.post(`/claims/${claimId}/liability/parts`, { part: 'X part', material: 'Metal', action: 'Repair', allowed: 'Allowed' })).status === 409);

    // ---------- FLA ----------
    r = await H.get(`/claims/${claimId}/fla`);
    check('FLA seeded from the Handler ILA', r.status === 200 && r.data.seeded && r.data.seededFrom === 'Handler ILA' && r.data.parts.length === glass + 1 && r.data.totals.netLiability === handlerNet, r.data?.seededFrom);
    r = await H.patch(`/claims/${claimId}/fla/parts/${r.data.parts[0].id}`, { partPrice: r.data.parts[0].partPrice + 1000 });
    check('FLA edits do not touch the Handler ILA', r.data.totals.netLiability > handlerNet && (await H.get(`/claims/${claimId}/liability`)).data.totals.netLiability === handlerNet);
    raw = await H.raw('POST', `/claims/${claimId}/fla/report`);
    check('FLA report PDF', raw.status === 200 && raw.headers.get('content-disposition').includes('FLA-'));
    r = await H.post(`/claims/${claimId}/fla/submit`);
    check('FLA submit -> stage payment', r.status === 200 && (await H.get(`/claims/${claimId}`)).data.stage === 'payment-recommendation');
    const net = r.data.totals.netLiability;

    // ---------- payment recommendation ----------
    r = await H.get(`/claims/${claimId}/payment`);
    check('payment: Handler ILA + approved FLA amounts, net payable = FLA', r.data.summary.handlerIla === handlerNet && r.data.summary.approvedFla === net, r.data.summary);
    check('payment: net payable from FLA, workshop payee prefilled, approver from Admin users', r.data.summary.netPayable === net && r.data.payees[0]?.payeeName === 'ABC Motors' && r.data.approval.approverName.startsWith('Vikram Singh'), r.data);
    check('submit without bank details -> 400', (await H.post(`/claims/${claimId}/payment/submit`)).status === 400);
    const payee = { ...r.data.payees[0], bankName: 'HDFC Bank Ltd.', bankBranch: 'Noida', ifsc: 'hdfc0001234', accountNo: '123456789012345' };
    check('bad IFSC -> 400', (await H.put(`/claims/${claimId}/payment`, { details: r.data.details, payees: [{ ...payee, ifsc: 'XX' }] })).status === 400);
    r = await H.put(`/claims/${claimId}/payment`, { details: { ...r.data.details, mode: 'imps' }, payees: [{ ...payee, amount: net - 500 }] });
    check('save payment (IFSC normalised)', r.status === 200 && r.data.payees[0].ifsc === 'HDFC0001234' && r.data.unallocated === 500, r.data);
    check('full payment must allocate all -> 400', (await H.post(`/claims/${claimId}/payment/submit`)).status === 400);
    r = await H.post(`/claims/${claimId}/payment/submit`, { details: r.data.details, payees: [{ ...payee, amount: net }] });
    check('submit for approval', r.status === 200 && r.data.status === 'Pending Approval' && r.data.approval.status === 'Pending For Approval From Next Level', r.data);

    // ---------- survey paybill ----------
    r = await H.get(`/claims/${claimId}/paybill`);
    check('paybill from the final surveyor + bank details from Admin profile', r.data.assigned && r.data.survey[0].value === 'Suresh Sharma' && r.data.bank.find((b) => b.key === 'ifsc').value === 'HDFC0001234' && r.data.bill[3].value === 'Test Insurance', r.data);
    r = await H.put(`/claims/${claimId}/paybill`, { lines: [{ key: 'distance', rate: 12, qty: 35 }, { key: 'surveyor-fee', rate: 1500, qty: 1 }], mode: 'manual', remark: 'FLA survey completed.' });
    check('save paybill', r.data.lines.find((l) => l.key === 'surveyor-fee').rate === 1500 && r.data.total === (1500 + 420 + 300 + 500 + 100) * 1.18, r.data?.total);
    r = await H.put(`/claims/${claimId}/paybill`, { lines: r.data.lines, mode: 'auto', remark: 'FLA survey completed.' });
    check('auto mode = standard rates', r.data.lines.find((l) => l.key === 'surveyor-fee').rate === 1200 && r.data.mode === 'auto');
    raw = await H.raw('POST', `/claims/${claimId}/paybill/pdf`, {});
    check('Generate PDF', raw.status === 200 && raw.buf.subarray(0, 5).toString() === '%PDF-');
    r = await H.get(`/claims/${claimId}`);
    check('journey complete -> claim Closed', r.data.status === 'Closed' && r.data.stage === 'completed' && r.data.stages.every((s) => s.done), r.data.stages);
    check('Admin portal: Settled', (await A.get(`/claims/${claimNo}`)).data.stage === 'Settled');

    // ---------- letters ----------
    r = await H.get(`/claims/${claimId}/letters`);
    check('letters: next no + contact', /^LET-\d{6}-001$/.test(r.data.nextLetterNo) && r.data.contact.email === 'amit.verma@test.in', r.data);
    const letter = {
        form: { letterType: 'documents-required', requestingOn: 'intimation-stage', priority: 'high', issueDate: '2026-10-21', responseDueBy: '2026-10-28', reason: 'documents-not-submitted', remarks: 'Pending papers', instructions: 'Share soon.' },
        requirements: [{ label: 'Claim Form', checked: true }, { label: 'FIR', checked: true }, { label: 'Permit', checked: false }],
        channel: 'email', contact: { mobile: '9876543210', email: 'amit.verma@test.in' },
    };
    check('letter needs a checked requirement', (await H.post(`/claims/${claimId}/letters`, { ...letter, requirements: [{ label: 'x', checked: false }] })).status === 400);
    raw = await H.raw('POST', `/claims/${claimId}/letters/preview.pdf`, letter);
    check('Download (preview PDF)', raw.status === 200 && raw.buf.subarray(0, 5).toString() === '%PDF-');
    r = await H.post(`/claims/${claimId}/letters`, letter);
    check('Generate Letter (sent by email)', r.status === 201 && r.data.delivery.status === 'Delivered' && r.data.letter.items.length === 2, r.data);
    const letterNo = r.data.letter.id;
    raw = await H.raw('GET', `/claims/${claimId}/letters/${letterNo}/pdf`);
    check('letter PDF', raw.status === 200);
    r = await H.post(`/claims/${claimId}/letters`, { ...letter, channel: undefined, channels: ['sms', 'email', 'whatsapp'] });
    check('one letter on SMS + Email + WhatsApp', r.status === 201 && r.data.delivery.deliveries.length === 3 && r.data.letter.channel === 'SMS, Email, WhatsApp', r.data);
    gatewayFails = true;
    r = await H.post(`/claims/${claimId}/letters`, { ...letter, channel: 'sms' });
    check('gateway down -> letter logged as Failed', r.status === 201 && r.data.delivery.status === 'Failed', r.data);
    gatewayFails = false;

    // ---------- communication history ----------
    r = await H.get(`/claims/${claimId}/communications`);
    const letterComm = r.data.rows.find((x) => x.letterId === letterNo);
    check('communication log has links, surveyor SMS and letters', r.data.counts.sent >= 5 && letterComm?.bullets?.length === 2 && r.data.counts.pending >= 3, r.data.counts);
    const pendingBefore = r.data.counts.pending;
    r = await H.post(`/claims/${claimId}/communications`, { kind: 'response', from: 'Amit Verma', fromRole: 'Insured', channel: 'Email', message: 'Documents attached.', replyTo: letterComm.id });
    check('record a response (closes the pending letter)', r.status === 201 && r.data.counts.received === 1 && r.data.counts.pending === pendingBefore - 1 && r.data.rows[0].reference === `Re: ${letterNo}`, r.data.counts);
    r = await H.post(`/claims/${claimId}/communications`, { kind: 'note', message: 'Customer called back.' });
    check('Add Note', r.data.rows[0].type === 'Note Added');
    r = await H.post(`/claims/${claimId}/communications`, { kind: 'sms', to: '9876543210', message: 'Your claim is approved.' });
    check('Send SMS', r.data.rows[0].type === 'SMS Sent' && r.data.rows[0].status === 'Delivered');
    check('Send Email needs a valid address', (await H.post(`/claims/${claimId}/communications`, { kind: 'email', to: 'nope', message: 'x' })).status === 400);
    raw = await H.raw('GET', `/claims/${claimId}/communications/export.csv`);
    r = await H.get('/dashboard/analytics?days=7');
    check('analytics: trend, status, sources', r.status === 200 && r.data.trend.length === 7 && r.data.trend.at(-1).count === 1 && r.data.status.find((x) => x.key === 'allocated').value === 1 && r.data.sources.find((x) => x.key === 'Call Center').value === 1, r.data);
    check('analytics: survey link summary counts the opened link', r.data.linkSummary.rows[0]?.sent === 1 && r.data.linkSummary.rows[0].accessed === 1 && r.data.linkSummary.rows[0].completed === 1 && r.data.linkSummary.rows[0].accessRate === 100, r.data.linkSummary);
    r = await H.get('/dashboard?location=Noida&insurer=Demo%20Insurance%20Co');
    check('quick filters: location + insurer', r.data.intimations.total >= 1 && r.data.filterOptions.locations.includes('Noida'), r.data.filterOptions);
    check('quick filters: other insurer -> nothing', (await H.get('/dashboard?insurer=Nobody')).data.intimations.rows.filter((x) => x.status !== 'Draft').length === 0);
    check('Export History CSV', raw.status === 200 && raw.buf.toString().startsWith('Date & Time'));
    check('agent sees communication history', (await AG2.get(`/claims/${claimId}/communications`)).status === 200);

    // ---------- customer survey web link ----------
    {
        // a fresh claim (the main one is closed by now) -- the link works from the draft on
        const S = api(CC);
        const draft = (await AG2.post('/claims', { intimation: intimation() })).data;
        r = await AG2.post(`/claims/${draft.id}/survey-link`, { recipients: ['Insured'], sendVia: ['SMS'], mobile: '9876543210' });
        const claimId = draft.id;
        const t = encodeURIComponent(r.data.link.token);
        check('survey on a closed claim -> 409', (await S.upload(`/survey/${encodeURIComponent(closedToken)}/files/vehicle-photos`, PNG, 'image/png', 'x.png')).status === 409);
        check('survey page: bad token -> 404', (await S.get('/survey/not-a-real-token-123')).status === 404);
        r = await S.get(`/survey/${t}`);
        check('survey page shows the intimation details', r.status === 200 && r.data.claimNo === draft.claimNo && r.data.assistClaimId === claimId
            && r.data.vehicle.registrationNumber === 'DL 01 AB 1234' && r.data.insured.name && r.data.insurer.name, r.data);
        const pre = await fetch(`${CC}/survey/${t}/files/vehicle-photos`, { method: 'OPTIONS', headers: { Origin: 'https://ibimaassist.online', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,x-file-name' } });
        check('survey API allows the web-app origin (CORS preflight)', pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://ibimaassist.online');
        check('survey submit needs uploads first', (await S.post(`/survey/${t}/submit`, {})).status === 400);
        check('survey upload: wrong type -> 400', (await S.upload(`/survey/${t}/files/rc`, Buffer.from('x'), 'text/plain', 'a.txt')).status === 400);
        check('survey upload: unknown doc type -> 400', (await S.upload(`/survey/${t}/files/nope`, PNG, 'image/png', 'a.png')).status === 400);
        r = await S.upload(`/survey/${t}/files/vehicle-photos`, PNG, 'image/png', 'survey-front.png');
        check('survey photo upload', r.status === 201 && r.data.document.type === 'vehicle-photos', r.data);
        check('survey document upload (DL front)', (await S.upload(`/survey/${t}/files/dl`, PDF, 'application/pdf', 'survey-dl-front.pdf')).status === 201);
        await S.upload(`/survey/${t}/files/dl`, PNG, 'image/png', 'survey-dl-back.png');
        await S.upload(`/survey/${t}/files/dl`, PNG2, 'image/png', 'survey-dl-back.png'); // re-take replaces the back only
        check('walk-around video upload', (await S.upload(`/survey/${t}/files/survey-video`, Buffer.from('webm-bytes'), 'video/webm', 'walk-around.webm')).status === 201);
        check('video only as survey-video', (await S.upload(`/survey/${t}/files/vehicle-photos`, Buffer.from('v'), 'video/webm', 'v.webm')).status === 400);
        r = await S.post(`/survey/${t}/submit`, { owner: { ownerName: 'Amit Verma', odometer: '12000' }, recommendation: 'approved' });
        check('survey submitted', r.status === 200 && r.data.fileCount === 4, r.data);
        check('second submit -> 409', (await S.post(`/survey/${t}/submit`, {})).status === 409);
        check('no uploads after submit', (await S.upload(`/survey/${t}/files/vehicle-photos`, PNG, 'image/png', 'late.png')).status === 409);
        r = await AG2.get(`/claims/${claimId}/documents`);
        const fromSurvey = (r.data?.files ?? []).filter((f) => f.uploadedBy === 'Customer (Survey Link)');
        check('survey files are in the Documents DMS (DL front + back kept, re-take replaced)', fromSurvey.length === 4 && fromSurvey.filter((f) => f.type === 'dl').length === 2 && fromSurvey.some((f) => f.name === 'walk-around.webm' && f.typeLabel === 'Walk Around Video'), fromSurvey);
        const vid = fromSurvey.find((f) => f.type === 'survey-video');
        const vf = vid ? await fetch(`${CC}${vid.url}`) : null;
        check('walk-around video opens from the DMS', vf?.status === 200 && vf.headers.get('content-type') === 'video/webm');
        r = await AG2.get(`/claims/${claimId}/communications`);
        check('"Survey Submitted" in Communication History', JSON.stringify(r.data).includes('Survey Submitted'), r.data);
        r = await AG2.get(`/claims/${claimId}`);
        check('claim link shows the survey submission', !!r.data.link.survey?.submittedAt && r.data.link.survey.owner.ownerName === 'Amit Verma', r.data.link);
    }

    // ---------- remarks + audit trail ----------
    r = await H.post(`/claims/${claimId}/remarks`, { text: 'Spoke to workshop.' });
    check('add remark', r.status === 201 && r.data[0].text === 'Spoke to workshop.');
    r = await H.get(`/claims/${claimId}/audit`);
    check('Claim Audit Trail records the journey', r.data.length > 20 && r.data.some((e) => e.action === 'Intimation submitted') && r.data.some((e) => e.action === 'Payment recommended'), r.data.length);

    // ---------- one user, several roles (Admin > Create Users, multi-select) ----------
    {
        r = await A.post('/users', user({ roleKey: 'call-center', roleKeys: ['call-center', 'state-manager', 'internal-surveyor'], name: 'Multi Role', userId: 'multi.role', email: 'multi@test.in', employeeId: 'MR01', contact: '9811000099', extra: { agentCode: 'CC-1099' } }));
        check('admin creates a user with 3 roles', r.status === 201 && r.data.roleKey === 'call-center' && r.data.roleKeys.length === 3, r.data);
        const multiId = r.data.id;
        check('bad role in roleKeys -> 400', (await A.patch(`/users/${multiId}`, { roleKeys: ['call-center', 'no-such-role'] })).status === 400);
        check('Roles & Permissions counts the additional role', ((await A.get('/roles')).data ?? []).find((x) => x.key === 'state-manager')?.users === 2);
        r = await pub.post('/auth/login', { identifier: 'multi.role', password: 'Temp@1234' });
        check('multi-role user signs in with the primary role', r.status === 200 && r.data.user.roleKey === 'call-center', r.data);
        check('portal roles = the web roles only (mobile surveyor role left out)', JSON.stringify(r.data.user.roles?.map((x) => x.roleKey)) === '["call-center","state-manager"]', r.data.user.roles);
        const MR = api(CC, r.data.token);
        check('as Call Center: Handler Allocation -> 403', (await MR.get('/handlers')).status === 403);
        check('cannot switch to a role not held -> 400', (await MR.post('/auth/switch-role', { roleKey: 'claim-handler' })).status === 400);
        check('cannot switch to a mobile-only role -> 400', (await MR.post('/auth/switch-role', { roleKey: 'internal-surveyor' })).status === 400);
        r = await MR.post('/auth/switch-role', { roleKey: 'state-manager' });
        check('switch role -> new session in that role', r.status === 200 && r.data.user.roleKey === 'state-manager' && r.data.user.permissions['Handler Allocation'].view === true, r.data);
        const SM = api(CC, r.data.token);
        check('as State Manager: Handler Allocation opens', (await SM.get('/handlers')).status === 200);
        check('auth/me follows the picked role', (await SM.get('/auth/me')).data?.user?.roleName === 'State Manager');
        check('the old token keeps its own role', (await MR.get('/auth/me')).data?.user?.roleKey === 'call-center');
        r = await A.patch(`/users/${multiId}`, { roleKey: 'call-center', roleKeys: ['call-center'] });
        check('admin removes the extra roles', r.status === 200 && r.data.roleKeys.length === 1, r.data);
        await new Promise((res) => setTimeout(res, 1200)); // user cache
        check('removed role falls back to the default role', (await SM.get('/handlers')).status === 403 && (await SM.get('/auth/me')).data?.user?.roleKey === 'call-center');
    }

    // ---------- account changes in the Admin portal apply at once ----------
    r = await A.post('/users/bulk-status', { ids: [h1.id], status: 'Suspended' });
    check('admin suspends a handler', r.status === 200);
    const H1 = firstHandler === h1.id ? H : null;
    if (H1) check('suspended user is signed out on the next request', (await H1.get('/dashboard')).status === 401);
    check('suspended user cannot sign in', (await pub.post('/auth/login', { identifier: 'rahul.ch', password: 'Temp@1234' })).status === 403);
    check('Admin Audit Logs show portal sign-ins', ((await A.get('/audit-logs')).data ?? []).some((l) => l.module === 'Call Center Portal'));
    check('internal API needs the service key', (await fetch(`${ADMIN}/internal/directory?roles=claim-handler`)).status === 401);
} catch (err) {
    fail++;
    console.error(err);
} finally {
    admin.kill();
    cc.kill();
    mock.close();
    await new Promise((r) => setTimeout(r, 400));
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch { /* Windows may hold the db a moment longer */ }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) {
        console.log('\n--- callcenter-service log ---\n', logs.cc.slice(-3000));
        console.log('\n--- admin-service log ---\n', logs.admin.slice(-2000));
    }
    process.exit(fail ? 1 : 0);
}
