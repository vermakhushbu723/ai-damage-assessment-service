// Allowed values -- kept identical to the option lists of the portal
// (car-damage-insurance-callcenter/src/config + src/data) so the API rejects
// anything the screens could not have sent.

/** Claim journey, in order. A claim's `stage` is the next step still to do. */
export const STAGES = [
    { key: 'intimation', label: 'Intimation' },
    { key: 'handler-allocation', label: 'Handler Allocation' },
    { key: 'surveyor-assignment', label: 'Surveyor Assignment' },
    { key: 'claim-details', label: 'Claim Details' },
    { key: 'ai-ila', label: 'AI ILA' },
    { key: 'fla', label: 'FLA' },
    { key: 'payment-recommendation', label: 'Payment Recommendation' },
    { key: 'survey-paybill', label: 'Survey Paybill' },
];
export const STAGE_KEYS = STAGES.map((s) => s.key);
export const COMPLETED = 'completed';
export const stageLabel = (key) => STAGES.find((s) => s.key === key)?.label ?? (key === COMPLETED ? 'Completed' : key);

/** Stage names of the Admin portal (admin-service CLAIM_STAGES). */
export const ADMIN_STAGE = {
    intimation: 'Intimation',
    'handler-allocation': 'Intimation',
    'surveyor-assignment': 'Intimation',
    'claim-details': 'Survey',
    'ai-ila': 'AI ILA',
    fla: 'ILA',
    'payment-recommendation': 'FLA',
    'survey-paybill': 'FLA',
    [COMPLETED]: 'Settled',
};

/** Admin portal claim types by intimation "Product". */
export const ADMIN_CLAIM_TYPE = { 'Private Car': 'Motor Vehicle', 'Two Wheeler': 'Two Wheeler', CV: 'Commercial Vehicle' };

/** Admin portal regions (North/East/West/South/Central) by state. */
export const REGION_OF_STATE = {
    Delhi: 'North', 'Uttar Pradesh': 'North', Haryana: 'North', Punjab: 'North', Rajasthan: 'North', Uttarakhand: 'North',
    'Himachal Pradesh': 'North', 'Jammu and Kashmir': 'North', Chandigarh: 'North',
    Maharashtra: 'West', Gujarat: 'West', Goa: 'West',
    Karnataka: 'South', 'Tamil Nadu': 'South', Kerala: 'South', Telangana: 'South', 'Andhra Pradesh': 'South', Puducherry: 'South',
    'West Bengal': 'East', Odisha: 'East', Bihar: 'East', Jharkhand: 'East', Assam: 'East',
    'Madhya Pradesh': 'Central', Chhattisgarh: 'Central',
};

// ---- permission modules (admin-service Roles & Permissions) ----
export const MODULES = {
    dashboard: 'Dashboard',
    intimation: 'Claim Intimation',
    handler: 'Handler Allocation',
    surveyor: 'Surveyor Assignment',
    details: 'Claim Details',
    aiIla: 'AI ILA',
    handlerIla: 'Handler ILA',
    fla: 'FLA',
    payment: 'Payment Recommendation',
    approval: 'Approval',
    paybill: 'Survey Fee Bill',
    dms: 'Document/DMS',
    letters: 'Requirement Letters',
    communication: 'Communication History',
};

// ---- people (admin-service role keys) ----
export const HANDLER_ROLES = ['claim-handler'];
export const SURVEYOR_ROLES = ['internal-surveyor', 'external-surveyor'];
export const APPROVER_ROLES = ['state-manager', 'regional-manager', 'national-manager'];

// ---- intimation ----
export const PRIORITIES = ['High', 'Medium', 'Low'];
export const SOURCES = ['Call Center', 'Direct', 'Chatbot', 'Website', 'App'];
/** Must be filled before an intimation can be submitted. */
export const INTIMATION_REQUIRED = {
    intimationSource: 'Intimation Source',
    callerName: 'Caller Name',
    callerContact: 'Caller Contact Number',
    insuredName: 'Insured Name',
    insuredContact: 'Insured Contact Number',
    policyNumber: 'Policy Number',
    registrationNumber: 'Registration Number',
    dateOfIncident: 'Date Of Incident',
    incidentCity: 'City (Place Of Incident)',
};
export const LINK_RECIPIENTS = ['Workshop Contact', 'Insured', 'Both'];
export const LINK_CHANNELS = ['SMS', 'Whats App', 'Email', 'All'];

// ---- reassignment ----
export const REASSIGNMENT_REASONS = { workload: 'Workload Balancing', leave: 'Handler On Leave', location: 'Location Mismatch', escalation: 'Escalation' };
export const REASSIGNMENT_REMARKS = { 'on-request': 'Reassigned On Request', supervisor: 'Reassigned By Supervisor', other: 'Other' };
export const SURVEY_TYPES = { spot: 'Spot Survey', final: 'Final Survey' };

// ---- documents ----
export const DOC_TYPES = {
    rc: 'RC Certificate',
    dl: 'Driving Licence',
    'claim-form': 'Claim Form',
    'policy-copy': 'Policy Copy',
    estimate: 'Estimate',
    'vehicle-photos': 'Vehicle Photos',
    fir: 'FIR',
    permit: 'Permit',
    fitness: 'Fitness',
    kyc: 'KYC Documents',
    aadhar: 'Aadhar Documents',
    'surveyor-report': 'Surveyor Report',
    other: 'Other Documents',
};
/** "Pending" on the Documents DMS screen until uploaded. */
export const REQUIRED_DOC_TYPES = ['dl', 'rc', 'estimate', 'policy-copy', 'claim-form'];
export const UPLOAD_MIME = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf',
};

// ---- AI ILA ----
export const DAMAGE_TYPES = ['Crack', 'Broken Part', 'Dent', 'Scratch', 'Paint Damage'];
export const SEVERITIES = ['Severe', 'Moderate', 'Minor'];
export const DAMAGE_ACTIONS = ['Repair', 'Replace'];
export const DAMAGE_STATUSES = ['Pending', 'Approval', 'In Review', 'Rejected'];
export const TRACKED_FIELDS = ['damageType', 'severity', 'action', 'cost', 'status'];

// ---- Handler ILA (liability) ----
export const MATERIALS = ['Metal', 'Plastic', 'Glass Fiber', 'Rubber'];
export const ALLOWED = ['Allowed', 'Disallowed'];
/** Depreciation on parts by material (IRDAI motor schedule, simplified). */
export const DEPRECIATION = { Metal: 0.5, Plastic: 0.5, Rubber: 0.5, 'Glass Fiber': 0.3 };
export const PARTS_GST = 0.28;
export const LABOUR_GST = 0.18;
/** Labour per part when the reviewer gives none: remove & refit (replace), repair, paint. */
export const LABOUR_RATES = { removeRefit: 800, repair: 1200, paint: 1500 };
export const COMPULSORY_EXCESS = 1000;
export const DEFAULT_HSN = '8708';

// ---- payment ----
export const PAYMENT_TYPES = ['full', 'partial'];
export const PAYMENT_MODES = ['neft', 'imps', 'cheque', 'upi'];
export const PAYMENT_PRIORITIES = ['normal', 'high', 'urgent'];
export const PAYEE_TYPES = ['Workshop', 'Insured', 'Surveyor'];
export const PAYMENT_FOR = ['Repair Expenses', 'Towing Charges', 'Survey Fee'];

// ---- survey paybill ----
export const PAYBILL_LINES = [
    { key: 'surveyor-fee', label: 'Surveyor Fee (Bases)', rate: 1200, qty: 1, basis: 'Per Survey' },
    { key: 'distance', label: 'Distance Allowance', rate: 12, qty: 0, basis: 'Kms' },
    { key: 'outstation', label: 'Outstation Allowance', rate: 300, qty: 1, basis: '01' },
    { key: 'report', label: 'Report Preparation', rate: 500, qty: 1, basis: '01' },
    { key: 'other', label: 'Other Expenses', rate: 100, qty: 1, basis: '01' },
];
export const PAYBILL_GST = 0.18;

// ---- letters ----
export const LETTER_TYPES = { 'vehicle-not-in-workshop': 'Vehicle Not in Workshop', 'documents-required': 'Documents Required' };
export const REQUESTING_ON = { 'intimation-stage': 'Intimation Stage', 'survey-stage': 'Survey Stage', 'assessment-stage': 'Assessment Stage', 'approval-stage': 'Approval Stage' };
export const LETTER_PRIORITIES = ['high', 'medium', 'low'];
export const LETTER_REASONS = {
    'vehicle-not-in-workshop': 'Vehicle not in workshop at the time of intimation',
    'documents-not-submitted': 'Required documents not submitted',
    'incomplete-claim-form': 'Incomplete claim form',
    'additional-information': 'Additional information required for assessment',
};
export const LETTER_CHANNELS = { sms: 'SMS', email: 'Email', whatsapp: 'WhatsApp' };
export const REMARKS_LIMIT = 200;
export const INSTRUCTIONS_LIMIT = 150;

// ---- communication ----
/** Admin portal channel names (admin-service COMM_CHANNELS). */
export const ADMIN_CHANNEL = { SMS: 'SMS', Email: 'Email', WhatsApp: 'Whats App', 'Whats App': 'Whats App', Note: 'In App', Portal: 'In App' };
