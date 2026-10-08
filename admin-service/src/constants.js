// Allowed values -- kept identical to the dropdowns of the Admin portal
// (car-damage-insurance-admin/src/data/*.js) so the API rejects anything the
// screens could not have sent.

export const PERMISSION_MODULES = [
    'Dashboard', 'Claim Intimation', 'Handler Allocation', 'Surveyor Assignment', 'Claim Details', 'AI ILA',
    'Handler ILA', 'FLA', 'Payment Recommendation', 'Approval', 'Survey Fee Bill', 'Document/DMS',
    'Requirement Letters', 'Communication History', 'Fraud Triggers', 'TAT & SLA', 'Workshop Empanelment',
    'Vendor Empanelment', 'Reports & Analytics', 'Data Download', 'Users & Roles', 'System Configuration', 'Audit Logs',
];
export const PERMISSION_ACTIONS = ['view', 'edit', 'create', 'approve', 'download'];

// ---- users ----
export const ACCOUNT_TYPES = ['Internal', 'External'];
export const ACCOUNT_STATUSES = ['Active', 'Inactive', 'On Leave', 'Suspended', 'Resigned', 'Pending'];
/** Statuses that cannot sign in / be reset until activated again. */
export const BLOCKED_STATUSES = ['Suspended', 'Resigned'];
export const DEPARTMENTS = ['Claims', 'Motor Claims', 'Customer Service', 'Survey & Inspection', 'Operations', 'Finance', 'Fraud Control', 'Audit & Compliance'];
export const ZONES = ['North', 'South', 'East', 'West', 'Central', 'Pan India'];
export const COUNTRIES = ['India'];
export const PLATFORMS = ['mobile', 'web', 'both'];
export const STATES = [
    'Andhra Pradesh', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Karnataka', 'Kerala',
    'Madhya Pradesh', 'Maharashtra', 'Odisha', 'Punjab', 'Rajasthan', 'Tamil Nadu', 'Telangana',
    'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
];
export const DEFAULT_CAPACITY = 100;

// ---- service configuration ----
export const BRANCH_STATUSES = ['Active', 'Pending', 'Suspended'];
export const BRANCH_CLASSES = ['T20', 'A1', 'B2', 'J6', 'J8'];
export const TEMPLATE_CATEGORIES = ['Policy', 'Claims', 'Survey & Inspection', 'Renewal', 'Settlement', 'Customer Communication', 'Finance'];
export const ACTIVE_INACTIVE = ['Active', 'Inactive'];
export const COMM_STAGES = ['Intimation', 'Surveyor Assignment', 'Claim Details', 'AI ILA', 'Handler ILA', 'FLA', 'Payment Recommendation', 'Survey Fee Bill'];
export const COMM_CHANNELS = ['SMS', 'Email', 'Whats App', 'In App'];
export const COMM_RECIPIENTS = ['Insured', 'Claim Handler', 'Surveyor', 'Workshop', 'RM', 'Approver RM'];
export const SEND_TIMINGS = ['Immediately', 'After 1h', 'After 4h', 'After 24h'];
export const REMINDER_OPTIONS = ['--', '4h/8h', '24h', '24h/48h', '48h'];
export const COMM_LOG_STATUSES = ['Delivered', 'Failed', 'Pending'];

// ---- claims ----
export const REGIONS = ['North', 'East', 'West', 'South', 'Central'];
export const CLAIM_TYPES = ['Motor Vehicle', 'Two Wheeler', 'Commercial Vehicle', 'Fire', 'Other'];
export const CLAIM_STAGES = ['Intimation', 'Survey', 'AI ILA', 'ILA', 'FLA', 'Settled', 'Rejected'];
export const OPEN_STAGES = ['Intimation', 'Survey', 'AI ILA', 'ILA', 'FLA'];
export const CLOSED_STAGES = ['Settled', 'Rejected'];
export const JOURNEY_STAGES = {
    saas: ['Intimation', 'Handler Allocation', 'Surveyor Allocation', 'Claim Details', 'AI ILA', 'Handler ILA', 'FLA', 'Recommendation', 'Approval', 'Settlement', 'DMS'],
    full: ['Intimation', 'Handler Allocation', 'Surveyor Allocation', 'Claim Details', 'AI ILA', 'Handler ILA', 'FLA', 'Recommendation', 'Approval', 'Survey Fee Bill', 'Settlement', 'DMS'],
};
export const APPROVAL_STAGES = ['ILA Approval', 'FLA Approval', 'Payment Approval', 'All Approval'];
export const APPROVAL_ACTIONS = ['Auto Approve', 'Route to authority', 'Hold and escalate', 'Manual review'];
export const PAYEE_TYPES = ['Workshop', 'Ensured', 'Financer', 'Assignee', 'Nominee'];

// ---- fraud ----
export const SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];
export const FRAUD_STAGES = ['Intimation', 'Claim Details', 'AI ILA', 'Handler ILA', 'FLA', 'Recommendation', 'Payment Approval'];
export const TRIGGER_STATUSES = ['Open', 'Under review', 'Escalated', 'Cleared'];

// ---- reports / system ----
export const DATA_TYPES = ['Claims', 'Users', 'Survey', 'Payments', 'Audit Logs'];
export const DOWNLOAD_FORMATS = ['CSV', 'Excel', 'JSON'];
export const DOWNLOAD_TTL_DAYS = 7;
export const RETENTION_OPTIONS = ['1 Year', '3 Years', '5 Years', '7 Years', '10 Years'];
export const INTEGRATION_TYPES = ['Reset API', 'API', 'Gateway'];
export const ENVIRONMENTS = ['Production', 'UAT', 'Sandbox'];
