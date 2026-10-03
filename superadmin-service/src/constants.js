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
