// Allowed values for every enum-like field. Kept in one place so the routes
// validate against the same lists the console's dropdowns show.

export const ORG_TYPES = ['Insurer', 'Broker', 'Surveyor', 'Workshop'];
export const ORG_STATUSES = ['Active', 'Pending', 'Suspended', 'Expired'];
export const ID_TYPES = ['Pilot', 'Working'];
export const SERVICE_MODELS = ['SaaS', 'Service Provider'];

export const USER_ROLES = ['Manager', 'Surveyor', 'Admin', 'Claim Handler', 'Call Center', 'TCT', 'Sr TCT', 'National Manager'];
export const USER_STATUSES = ['Active', 'Pending', 'Inactive', 'Suspended'];
export const PLATFORMS = ['Mobile', 'Web', 'Both'];

export const ADMIN_STATUSES = ['Active', 'Pending', 'Suspended'];
export const ADMIN_SCOPES = ['all', 'saas', 'serviceProvider'];
// The service model a scoped super admin manages.
export const SERVICE_MODEL_OF_SCOPE = { saas: 'SaaS', serviceProvider: 'Service Provider' };

export const MASTER_ROLE = 'Super Admin';
export const SYSTEM_ROLES = ['Super Admin', 'Organisation admin', 'Support admin', 'Reporting admin'];

// Roles & Permission matrix shape (rows x columns).
export const PERMISSION_PAGES = [
    'Dashboard', 'Claim Intimation', 'Handler Allocation', 'Surveyor Assignment', 'Claim Details', 'AI ILA',
    'Handler ILA', 'FLA', 'Payment Recommendation', 'Approval', 'Survey Fee Bill', 'Document/DMS',
    'Requirement Letters', 'Communication History', 'Fraud Triggers', 'TAT & SLA', 'Workshop Empanelment',
    'Vendor Empanelment', 'Reports & Analytics', 'Data Download', 'Users & Roles', 'System Configuration', 'Audit Logs',
];
export const PERMISSION_ACTIONS = ['view', 'edit', 'create', 'approve', 'download'];

export const buildPermissionMatrix = (allOn) =>
    Object.fromEntries(PERMISSION_PAGES.map((p) => [p, Object.fromEntries(PERMISSION_ACTIONS.map((a) => [a, allOn]))]));

// Default plan catalog, created once on first start (editable from the console afterwards).
export const DEFAULT_PLANS = [
    { id: 'starter', name: 'Starter', price: 999, userLimit: 'Up To 10 Users', features: ['Claim Management', 'Basic Reports', 'Email Support'] },
    { id: 'professional', name: 'Professional', price: 2499, userLimit: 'Up To 50 Users', features: ['Claim Management', 'Basic Reports', 'Email Support & Chat Support', 'API Access'] },
    { id: 'enterprise', name: 'Enterprise', price: 4999, userLimit: 'Unlimited Users', features: ['All Professional Features', 'Priority Support', 'API Access', 'Custom Integrations'] },
    { id: 'custom', name: 'Custom', price: null, priceLabel: 'Custom Pricing', userLimit: 'Tailored For Your Business', features: ['All Features', 'Dedicated Support', 'Custom Integrations'] },
];

// ---------------- Service models ----------------
export const SERVICE_TYPES = ['Claims', 'Policy', 'Survey', 'Customer Service'];
export const APPLICABLE_FOR = ['Motor', 'Health', 'All', 'Motor, Health'];
export const PRIORITIES = ['High', 'Medium', 'Low'];
export const SERVICE_MODEL_STATUSES = ['Active', 'Pending', 'Suspended'];

// ---------------- Claims ----------------
export const CLAIM_STATUSES = ['Intimation', 'Survey', 'AI ILA', 'ILA', 'FLA', 'Settled', 'Rejected'];
export const REGIONS = ['North', 'East', 'West', 'South', 'Central'];
// Grouping used by the Claim Report KPI tiles.
export const CLAIM_GROUPS = {
    survey: ['Intimation', 'Survey'],
    assessment: ['AI ILA', 'ILA', 'FLA'],
    settlement: ['Settled'],
    rejected: ['Rejected'],
};

// ---------------- Data Download ----------------
export const DATA_TYPES = ['Claims', 'Users', 'Survey', 'Payments', 'Audit Logs', 'Organizations'];
export const DOWNLOAD_FORMATS = ['csv', 'excel'];
export const DOWNLOAD_TTL_DAYS = 7;

// ---------------- Workflow (one default config per mode, created once) ----------------
export const MODES = ['saas', 'serviceProvider'];
export const MODE_OF_SERVICE_MODEL = { SaaS: 'saas', 'Service Provider': 'serviceProvider' };
export const SERVICE_MODEL_OF_MODE = { saas: 'SaaS', serviceProvider: 'Service Provider' };

const APPROVE_STAGES = ['FLA', 'Recommendation', 'Approval', 'Settlement', 'Fee Bill'];
const rule = (stage, role, systemRule) => ({ stage, role, systemRule, enabled: true, view: true, edit: true, approve: APPROVE_STAGES.includes(stage) });
const defaultTriggers = () => [
    { id: 't1', trigger: 'Claim Registered', stage: 'Intimation', recipient: 'Insure/Handler', channels: 'Whatsapp+email', status: 'Active' },
    { id: 't2', trigger: 'Surveyor Assigned', stage: 'Surveyor Allocation', recipient: 'Surveyor', channels: 'SMS+Whatsapp', status: 'Active' },
    { id: 't3', trigger: 'Documents Pending', stage: 'Claim Details', recipient: 'Customer/Workshop', channels: 'Letter+email', status: 'Active' },
    { id: 't4', trigger: 'ILA Submitted', stage: 'AI ILA', recipient: 'Handler/TCT', channels: 'In - app', status: 'Active' },
    { id: 't5', trigger: 'Recommendation Ready', stage: 'Recommendation', recipient: 'Approver', channels: 'In - app+email', status: 'Active' },
];

export const DEFAULT_WORKFLOWS = {
    saas: {
        journeyTitle: 'Claim Journey - SaaS',
        banner: 'SaaS: Surveyor Allocation, Recommendation & Approval Are Enabled. Fee Bill Is Not Applicable',
        stages: ['Intimation', 'Handler Allocation', 'Surveyor Allocation', 'Claim Details', 'AI ILA', 'Handler ILA', 'FLA', 'Recommendation', 'Approval', 'Settlement'],
        rules: [
            rule('Intimation', 'Call Center', 'Insurer Control'),
            rule('Handler Allocation', 'National Manager', 'Insurer Control'),
            rule('Surveyor Allocation', 'Internal Surveyor', 'Insurer Control'),
            rule('Claim Details', 'Claim Handler', 'Insurer Control'),
            rule('AI ILA', 'TCT', 'Insurer Control'),
            rule('Handler ILA', 'Claim Handler', 'Insurer Control'),
            rule('FLA', 'Sr TCT', 'Insurer Control'),
            rule('Recommendation', 'National Manager', 'Insurer Control'),
            rule('Approval', 'HO/Admin', 'Insurer Control'),
            rule('Settlement', 'HO/Admin', 'Insurer Control'),
        ],
        overview: { operatingModel: 'SaaS-Insurer operates claim', insurer: null, adminProfile: 'HO/National Manager', feeBillModel: 'Not Applicable-SaaS' },
        triggers: defaultTriggers(),
        autoRoles: ['TCT', 'Sr TCT'],
        activatedAt: null,
    },
    serviceProvider: {
        journeyTitle: 'Claim Journey - As Service Provider',
        banner: 'As Service Provider: Surveyor Allocation, Recommendation And Payment Approval Are Hidden. Fee Bill Is Enabled.',
        stages: ['Intimation', 'Handler Allocation', 'Claim Details', 'AI ILA', 'Handler ILA', 'FLA', 'Fee Bill'],
        rules: [
            rule('Intimation', 'Call Center', 'Vendor service stage'),
            rule('Handler Allocation', 'National Manager', 'Vendor service stage'),
            rule('Claim Details', 'Claim Handler', 'Vendor service stage'),
            rule('AI ILA', 'AI assesment', 'Vendor service stage'),
            rule('Handler ILA', 'Claim Handler', 'Vendor service stage'),
            rule('FLA', 'Sr Technical reviewer', 'Vendor service stage'),
            rule('Fee Bill', 'National Manager', 'Vendor service stage'),
        ],
        overview: { operatingModel: 'IBima assist service workflow', insurer: null, adminProfile: 'HO/National Manager', feeBillModel: 'Automatic-based on product model' },
        triggers: defaultTriggers().filter((t) => !['Surveyor Allocation', 'Recommendation'].includes(t.stage)),
        autoRoles: ['TCT', 'Sr TCT'],
        activatedAt: null,
    },
};
export const OPERATING_MODELS = ['SaaS-Insurer operates claim', 'IBima assist service workflow'];
export const ADMIN_PROFILES = ['HO/National Manager', 'Regional Manager', 'Branch Manager'];
export const FEE_BILL_MODELS = ['Automatic-based on product model', 'Manual entry', 'Not Applicable-SaaS'];
export const CHANNELS = ['Whatsapp', 'email', 'SMS', 'Letter', 'In - app'];
export const AUTO_ROLES = ['TCT', 'Sr TCT', 'Claim Handler', 'Internal Surveyor', 'National Manager', 'HO/Admin'];

// ---------------- System Settings ----------------
// Integrations start "Not Configured": no endpoint until an admin enters the real one.
export const DEFAULT_INTEGRATIONS = [
    { id: 'policy-los', name: 'Policy/LOS API', description: 'Policy - Customer & Claim Data', type: 'Reset API', environment: 'Production' },
    { id: 'vehicle-rc', name: 'Vehicle/RC Verification', description: 'Vehicle & Registration Verification', type: 'API', environment: 'Production' },
    { id: 'comm-gateway', name: 'Communication Gateway', description: 'SMS/Email/Whatsapp', type: 'Gateway', environment: 'Production' },
];
export const INTEGRATION_TYPES = ['Reset API', 'API', 'Gateway', 'Webhook'];
export const ENVIRONMENTS = ['Production', 'UAT', 'Sandbox'];
export const RETENTION_OPTIONS = ['1 Year', '3 Years', '5 Years', '7 Years', '10 Years'];
export const DEFAULT_SYSTEM_SETTINGS = {
    environment: 'Production Environment',
    maintenanceApproval: false,
    autoSecurityPatches: false,
    maintenanceMode: false,
    auditLogin: true,
    retention: '7 Years',
    inputActivityLogging: false,
    configChangeApproval: false,
};
