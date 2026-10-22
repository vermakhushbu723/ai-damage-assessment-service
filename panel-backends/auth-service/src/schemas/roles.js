// The four portals car-damage-insurance-web-app logs into. Each role is the
// "unique key" the rest of the system uses to tell who's logging in --
// every user row belongs to exactly one role, every issued token carries
// its role as a claim, and any future data table (claims, inspections,
// photos, ...) can be scoped by (user_id, role) to keep each portal's data
// separate from the others.
//
// Add a new portal by adding one entry here + one seed user in db/seed.js --
// nothing else needs to change (login/me routes are role-agnostic).
export const ROLES = Object.freeze({
    CLAIM_WORKSHOP: 'claim_workshop',
    CLAIM_SURVEYOR: 'claim_surveyor',
    PREINSPECTION_AGENT: 'preinspection_agent',
    PREINSPECTION_SURVEYOR: 'preinspection_surveyor',
});

export const ROLE_LABELS = Object.freeze({
    [ROLES.CLAIM_WORKSHOP]: 'Claim Workshop',
    [ROLES.CLAIM_SURVEYOR]: 'Claim Surveyor',
    [ROLES.PREINSPECTION_AGENT]: 'Pre-Inspection Agent',
    [ROLES.PREINSPECTION_SURVEYOR]: 'Pre-Inspection Surveyor',
});

export const ROLE_VALUES = Object.freeze(Object.values(ROLES));

export function isValidRole(role) {
    return ROLE_VALUES.includes(role);
}
