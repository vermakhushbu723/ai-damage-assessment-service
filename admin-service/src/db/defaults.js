// Starting configuration written once on first start (db/bootstrap.js).
// Only configuration lives here -- roles, rule sets, templates, switches.
// No sample people, claims, triggers or logs: those come from the portal
// itself or from the claim systems (POST /claims/ingest).

import { PERMISSION_MODULES, PERMISSION_ACTIONS, JOURNEY_STAGES, PAYEE_TYPES } from '../constants.js';

const matrix = (fn) => Object.fromEntries(PERMISSION_MODULES.map((m) => [
    m,
    Object.fromEntries(PERMISSION_ACTIONS.map((a) => [a, fn(m, a)])),
]));
const ADMIN_ONLY = ['Users & Roles', 'System Configuration', 'Audit Logs'];
export const viewOnlyPermissions = () => matrix((_m, a) => a === 'view');

export const DEFAULT_ROLES = [
    { key: 'national-manager', name: 'National Manager', short: 'NM', chartLabel: 'National Manager (NM)', level: 1, extra: 'national-manager', permissions: matrix(() => true) },
    { key: 'regional-manager', name: 'Regional Manager', short: 'RCM', chartLabel: 'Regional Claim Manager (RCM)', level: 2, extra: 'regional-manager', permissions: matrix((m) => !ADMIN_ONLY.includes(m)) },
    { key: 'state-manager', name: 'State Manager', short: 'SCM', chartLabel: 'State Claim Manager (SCM)', level: 3, extra: 'state-manager', permissions: matrix((m, a) => !ADMIN_ONLY.includes(m) && a !== 'download') },
    { key: 'claim-handler', name: 'Claim Handler', formName: 'CSM/Handler', short: 'CH', chartLabel: 'Claim Handlers (CH)', level: 4, extra: 'claim-handler', permissions: matrix((m, a) => !ADMIN_ONLY.includes(m) && a !== 'approve') },
    { key: 'call-center', name: 'Call Center', formName: 'Call Center Agent', short: 'CC', level: 5, extra: 'call-center', permissions: matrix((m, a) => ['Dashboard', 'Claim Intimation', 'Communication History'].includes(m) && a !== 'approve') },
    { key: 'internal-surveyor', name: 'Internal Surveyor', short: 'IS', level: 5, extra: null, permissions: matrix((m, a) => ['Dashboard', 'Surveyor Assignment', 'Claim Details', 'Document/DMS'].includes(m) && a !== 'approve') },
    { key: 'external-surveyor', name: 'External Surveyor', short: 'ES', level: 5, extra: null, permissions: matrix((m, a) => ['Surveyor Assignment', 'Claim Details'].includes(m) && a === 'view') },
    { key: 'investigator', name: 'Investigator', short: 'INV', level: 5, extra: null, permissions: matrix((m, a) => ['Fraud Triggers', 'Claim Details', 'Document/DMS'].includes(m) && a !== 'approve') },
    { key: 'tct', name: 'TCT', short: 'TCT', level: 5, extra: null, permissions: viewOnlyPermissions() },
    { key: 'sr-tct', name: 'Sr. TCT', short: 'STCT', level: 4, extra: null, permissions: matrix((_m, a) => a === 'view' || a === 'approve') },
    { key: 'audit', name: 'Audit', short: 'AUD', level: 4, extra: null, permissions: matrix((_m, a) => a === 'view' || a === 'download') },
];

// ---------- settings documents ----------
export const DEFAULT_SETTINGS = {
    config: {
        claimFlow: { recommendationEngine: true, autoApproval: false },
        approval: { ila: true, fla: false },
        fraud: { autoApprove: false },
        journey: {
            mode: 'saas',
            enabled: {
                saas: Object.fromEntries(JOURNEY_STAGES.saas.map((s) => [s, true])),
                full: Object.fromEntries(JOURNEY_STAGES.full.map((s) => [s, true])),
            },
        },
        approvalRules: [
            { id: 'AR-1', name: 'ILA Approval Treshold', desc: 'Assessment amount ≤ configured threshold', enabled: true, severity: 'High', title: 'ILA Amount Threshold', stage: 'ILA Approval', condition: 'Amount Configured Threshold', action: 'Auto Approve', threshold: 50000 },
            { id: 'AR-2', name: 'FLA Exception Check', desc: 'Exception count = 0 AND survey complete', enabled: true, severity: 'High', title: 'FLA Expectation check', stage: 'FLA Approval', condition: 'Exception count = 0 and survey complete', action: 'Auto Approve' },
            { id: 'AR-3', name: 'Payment Amount Rule', desc: 'Amount within authority matrix', enabled: true, severity: 'Critical', title: 'Payment amount rule', stage: 'Payment Approval', condition: 'Amount within authority matrix', action: 'Route to authority', threshold: 200000 },
            { id: 'AR-4', name: 'Fraud Trigger Hold', desc: 'Critical fraud trigger = true', enabled: true, severity: 'Critical', title: 'Trigger hold', stage: 'All Approval', condition: 'Critical fraud = true', action: 'Hold and escalate' },
        ],
        approvalMatrix: [
            { id: 'AM-1', approval: 'FLA Approval', logic: 'Amount Based + Rule Engine', enabled: true },
            { id: 'AM-2', approval: 'Payment Approval', logic: 'Threshold + Exception', enabled: true },
            { id: 'AM-3', approval: 'FLA Approval', logic: 'RCM/SCM + Auto Trigger', enabled: false },
            { id: 'AM-4', approval: 'ILA Approval', logic: 'Amount Based + Rule Engine', enabled: true },
            { id: 'AM-5', approval: 'FLA Approval', logic: 'Threshold + Exception', enabled: false },
        ],
    },
    routing: {
        matrix: [
            { id: 'RT-1', severity: 'Critical', score: '50', action: 'Hold Claim', recipient: 'Audit + Sr.TCT', hold: 'Yes', active: true },
            { id: 'RT-2', severity: 'High', score: '30-49', action: 'Route Review', recipient: 'NM/Audit', hold: 'No', active: true },
            { id: 'RT-3', severity: 'Medium', score: '15-20', action: 'Handler Review', recipient: 'Handler', hold: 'No', active: true },
            { id: 'RT-4', severity: 'Low', score: '1-14', action: 'Log & Monitor', recipient: 'System', hold: 'No', active: true },
        ],
        safeguards: [
            { id: 'SG-1', label: 'Critical Trigger Blocks Auto Approval', on: true },
            { id: 'SG-2', label: 'High trigger requires review action', on: true },
            { id: 'SG-3', label: 'Every routing action is logged', on: true },
            { id: 'SG-4', label: 'Override requires reason', on: true },
        ],
    },
    recommendation: {
        rules: [
            { id: 'RR-1', rule: 'Below authority limit', condition: 'Amount 50K', stage: 'ILA', result: 'Auto recommended', status: 'Active' },
            { id: 'RR-2', rule: 'Estimate', condition: 'Approved limit', stage: 'FLA', result: 'Auto recommended', status: 'Active' },
            { id: 'RR-3', rule: 'High amount', condition: 'Above authority', stage: 'Payment Recomendation', result: 'TCT review', status: 'Active' },
            { id: 'RR-4', rule: 'Critical fraud', condition: 'Critical trigger', stage: 'Fraud trigger', result: 'Hold', status: 'Active' },
        ],
        payValidation: Object.fromEntries(PAYEE_TYPES.map((p) => [p, ['Bank Detail Validation', 'Duplicate Pay Check', 'Financer Interest Check', 'Partial Payment Allowed', 'PAN/KYC Validation']
            .map((label, ci) => ({ id: `${p}-${ci}`, label, on: true }))])),
    },
    stageConfig: {
        stages: [
            { id: 'ST-1', stage: 'Intimation', owner: 'Call Center', tat: '30 Min', active: true, rule: 'Mandatory: policy, vehicle & loss details' },
            { id: 'ST-2', stage: 'Handler Allocation', owner: 'NM/RCM', tat: '15 Min', active: true, rule: 'Auto-allocate by branch & handler capacity' },
            { id: 'ST-3', stage: 'Surey Assignment', owner: 'Surveyor Manager', tat: '02 Hrs', active: true, rule: 'Assign nearest empanelled surveyor' },
            { id: 'ST-4', stage: 'Claim Details', owner: 'Claim Handler', tat: '04 Hrs', active: true, rule: 'All mandatory documents uploaded' },
            { id: 'ST-5', stage: 'AI ILA', owner: 'AI+Handler', tat: '02 Hrs', active: true, rule: 'AI assessment on uploaded photos' },
            { id: 'ST-6', stage: 'Handler ILA', owner: 'Claim Handler', tat: '04 Hrs', active: true, rule: 'Handler verifies AI assessment' },
            { id: 'ST-7', stage: 'FLA', owner: 'FLA/Surveyor', tat: '02 Hrs', active: true, rule: 'Final loss assessment after repair' },
            { id: 'ST-8', stage: 'Recomendation', owner: 'TCT/Sr TCT', tat: '04 Hrs', active: true, rule: 'Within authority matrix' },
            { id: 'ST-9', stage: 'Approval', owner: 'Authority', tat: '02 Hrs', active: true, rule: 'Approval logic rules must pass' },
            { id: 'ST-10', stage: 'Payment', owner: 'Finance/LOS', tat: '04 Hrs', active: true, rule: 'Pay validation checks pass' },
        ],
        operatingModel: {
            saas: {
                banner: 'SaaS Can Expose Recommendation & Approval Based On Insurer Configuration',
                rows: [['Surveyor Assignment', 'Configurable'], ['Recommendation', 'Available'], ['Payment Approval', 'Available'], ['Fee Bill', 'Vendor Flow Dependent']],
            },
            provider: {
                banner: 'As Service Provider, IBima Assist Runs Survey, Assessment & Fee Bill For The Insurer',
                rows: [['Surveyor Assignment', 'Managed By IBima'], ['Recommendation', 'Available'], ['Payment Approval', 'Insurer Only'], ['Fee Bill', 'Applicable']],
            },
        },
    },
    // Switches of System Settings > System Update (versions come from .env / deployments).
    systemUpdate: { maintenanceApproval: false, autoSecurityPatches: false, maintenanceMode: false },
    compliance: { auditLogin: true, retention: '7 Years', inputLogging: false, configApproval: false },
};

// ---------- record collections ----------
const TEMPLATE_ROWS = [
    ['Motor Policy Schedule', 'Policy', 'Dear {{insured_name}},\n\nPlease find the schedule for your motor policy {{policy_no}} covering vehicle {{vehicle_no}}.\n\nPolicy period starts {{date}}. Keep this schedule with your vehicle documents.\n\nRegards,\n{{branch_name}}'],
    ['Motor Claim Intimation', 'Claims', 'Dear {{insured_name}},\n\nWe have registered your claim {{claim_no}} for vehicle {{vehicle_no}} under policy {{policy_no}} on {{date}}.\n\nOur claim handler will contact you shortly.\n\nRegards,\n{{branch_name}}'],
    ['Surveyor Visit Intimation', 'Survey & Inspection', 'Dear {{insured_name}},\n\nSurveyor {{surveyor_name}} has been assigned to inspect vehicle {{vehicle_no}} for claim {{claim_no}}.\n\nPlease keep the vehicle available at the workshop on {{date}}.\n\nRegards,\n{{branch_name}}'],
    ['Claim Settlement Letter', 'Settlement', 'Dear {{insured_name}},\n\nYour claim {{claim_no}} has been settled for {{amount}} on {{date}}.\n\nThe amount will reach your registered bank account within 3 working days.\n\nRegards,\n{{branch_name}}'],
    ['Policy Renewal Reminder', 'Renewal', 'Dear {{insured_name}},\n\nYour policy {{policy_no}} for vehicle {{vehicle_no}} is due for renewal on {{date}}.\n\nRenew on time to keep your No Claim Bonus.\n\nRegards,\n{{branch_name}}'],
    ['Requirement Letter', 'Customer Communication', 'Dear {{insured_name}},\n\nTo process claim {{claim_no}} we need the following documents: RC copy, driving licence, repair estimate.\n\nPlease upload them by {{date}}.\n\nRegards,\n{{branch_name}}'],
    ['Survey Fee Bill', 'Finance', 'Survey fee bill for claim {{claim_no}}\n\nSurveyor: {{surveyor_name}}\nVehicle: {{vehicle_no}}\nAmount: {{amount}}\nBill date: {{date}}'],
    ['Survey Report Format', 'Survey & Inspection', 'Survey report for claim {{claim_no}}\n\nVehicle: {{vehicle_no}}\nSurveyor: {{surveyor_name}}\nAssessed loss: {{amount}}\nInspection date: {{date}}'],
    ['Claim Rejection Letter', 'Claims', 'Dear {{insured_name}},\n\nAfter review, claim {{claim_no}} under policy {{policy_no}} could not be admitted.\n\nYou may write to {{branch_name}} within 30 days of {{date}} for a review.\n\nRegards,\n{{branch_name}}'],
    ['Payment Advice', 'Finance', 'Payment advice for claim {{claim_no}}\n\nPayee: {{insured_name}}\nAmount: {{amount}}\nValue date: {{date}}'],
];

const RULE_ROWS = [
    ['Intimation', 'Claim Registered', 'Claim Registration Confirmation', ['Insured', 'Claim Handler'], ['SMS', 'Whats App'], 'Immediately', '--'],
    ['Intimation', 'Vehicle not at workshop', 'Vehicle not at workshop- requirement letter', ['Insured', 'Claim Handler'], ['Email', 'Whats App'], 'Immediately', '24h/48h'],
    ['Intimation', 'Document Pending', 'Document Required Initial', ['Insured', 'Claim Handler'], ['Email', 'Whats App'], 'Immediately', '24h/48h'],
    ['Intimation', 'Survey Link Generator', 'Survey link self inspection', ['Insured'], ['SMS', 'Whats App'], 'Immediately', '24h'],
    ['Surveyor Assignment', 'Surveyor Assigned', 'Surveyor Assignment Notification', ['Insured', 'Surveyor', 'Claim Handler'], ['Email', 'Whats App'], 'Immediately', '--'],
    ['Claim Details', 'Additional Document Required', 'Additional Document Required', ['Insured', 'Workshop', 'Claim Handler'], ['Email', 'Whats App'], 'Immediately', '24h/48h'],
    ['AI ILA', 'AI ILA Completed', 'ILA Assesment Completed', ['Claim Handler', 'RM'], ['Email', 'In App'], 'Immediately', '--'],
    ['Handler ILA', 'ILA Verification Pending', 'Handler ILA Pending', ['Claim Handler'], ['Email', 'In App'], 'Immediately', '24h'],
    ['FLA', 'FLA Completed', 'FLA Completion Alert', ['Claim Handler', 'RM'], ['Email', 'In App'], 'Immediately', '--'],
    ['Payment Recommendation', 'Approval Required', 'Payment Approval Alert', ['Approver RM'], ['Email', 'In App'], 'Immediately', '4h/8h'],
    ['Survey Fee Bill', 'Bill Generated', 'Survey Bill Notification', ['Claim Handler', 'RM'], ['Email', 'In App'], 'Immediately', '48h'],
];

const pad = (n, w = 3) => String(n).padStart(w, '0');

export const DEFAULT_RECORDS = {
    documentTemplates: TEMPLATE_ROWS.map(([name, category, body], i) => ({
        id: `TPL-${pad(i + 1)}`, name, category, body, version: '1.0', status: 'Active', branchIds: [],
    })),
    commRules: RULE_ROWS.map(([stage, trigger, template, recipients, channels, initialSend, reminder], i) => ({
        id: `CR-${pad(i + 1)}`, stage, trigger, template, recipients, channels, initialSend, reminder, status: 'Active',
    })),
    commTemplates: [...new Set(RULE_ROWS.map((r) => r[2]))].map((name, i) => ({
        id: `CT-${pad(i + 1)}`,
        name,
        channel: RULE_ROWS.find((r) => r[2] === name)[4].join(', '),
        body: `Dear {{insured_name}}, update on claim {{claim_no}}: ${name}.`,
        status: 'Active',
    })),
    // Provider / sender are filled in by the admin; sending goes through the
    // Communication Gateway integration (System Settings).
    channels: [
        { id: 'CH-SMS', name: 'SMS', provider: '', senderId: '', enabled: true },
        { id: 'CH-EMAIL', name: 'Email', provider: '', senderId: '', enabled: true },
        { id: 'CH-WA', name: 'Whats App', provider: '', senderId: '', enabled: true },
        { id: 'CH-INAPP', name: 'In App', provider: '', senderId: '', enabled: true },
    ],
    fraudRules: [
        { id: 'FR-1', rule: 'Multiple Claims Same Vehicle', stage: 'Intimation', severity: 'High', score: 35, condition: 'Three claims in 90 days', action: 'Root to audit', active: true, key: 'priorClaims', threshold: 3 },
        { id: 'FR-2', rule: 'Damage Mismatch', stage: 'AI ILA', severity: 'High', score: 30, condition: 'AI Damage differs from declared loss', action: 'Angular review', active: true, key: 'mismatch' },
        { id: 'FR-3', rule: 'High Amount Expectation', stage: 'Recommendation', severity: 'Medium', score: 20, condition: 'Recommmendation exist threshold', action: 'Senior approval', active: true, key: 'amount', threshold: 50000 },
        { id: 'FR-4', rule: 'Duplicate Document', stage: 'Claim Details', severity: 'Critical', score: 50, condition: 'Same document  Hash used in another claim', action: 'Hold claim', active: true, key: 'duplicate' },
    ],
    authorityMatrix: [
        { id: 'AU-1', role: 'Claim Handler', motorOD: '25K', fire: '--', other: '10K' },
        { id: 'AU-2', role: 'TCT', motorOD: '75K', fire: '2L', other: '50K' },
        { id: 'AU-3', role: 'Sr. TCT', motorOD: '2L', fire: '10L', other: '2L' },
        { id: 'AU-4', role: 'National Manager', motorOD: 'Above Threshold', fire: 'Above Threshold', other: 'Above Threshold' },
    ],
    // Not Configured until an admin enters real endpoints (System Settings > Configure).
    integrations: [
        { id: 'INT-1', name: 'Policy/LOS API', desc: 'Policy - Customer & Claim Data', type: 'Reset API', env: 'Production', endpoint: '', status: 'Not Configured', responseSec: null, syncAt: null },
        { id: 'INT-2', name: 'Vehicle/RC Verification', desc: 'Vehicle & Registration Verification', type: 'API', env: 'Production', endpoint: '', status: 'Not Configured', responseSec: null, syncAt: null },
        { id: 'INT-3', name: 'Communication Gateway', desc: 'SMS/Email/Whatsapp', type: 'Gateway', env: 'Production', endpoint: '', status: 'Not Configured', responseSec: null, syncAt: null },
    ],
};

/** The integration "Send Test" / "Retry" messages go through. */
export const GATEWAY_INTEGRATION_ID = 'INT-3';
