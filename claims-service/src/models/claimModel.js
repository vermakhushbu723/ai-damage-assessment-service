import { randomUUID } from 'node:crypto';
import { db } from '../db/database.js';

function generateClaimNumber() {
    // CLM + 10 digits, e.g. CLM1737654321. Collisions are astronomically
    // unlikely (ms timestamp + this runs on a single instance for now),
    // and the UNIQUE constraint on claim_number is the real backstop.
    return `CLM${Date.now()}`;
}

/** Maps a DB row (snake_case) to the shape the frontend's DashboardPage / ClaimListCard expect (camelCase, plus a derived `vehicle` string). */
export function toPublicClaim(row) {
    if (!row) return null;
    return {
        id: row.id,
        claimNumber: row.claim_number,
        insurerName: row.insurer_name,
        insuredName: row.owner_name,
        registrationNumber: row.registration_number,
        status: row.status,
        vehicle: [row.make, row.model].filter(Boolean).join(' ') || null,
        surveyDate: row.survey_date,
        location: row.state || null,
        amount: row.amount,
        // Full form data, in case a future detail screen wants it --
        // DashboardPage/ClaimListCard only read the fields above.
        mobile: row.mobile,
        email: row.email,
        odometer: row.odometer,
        registrationDate: row.registration_date,
        product: row.product,
        make: row.make,
        model: row.model,
        variant: row.variant,
        manufacturingYear: row.manufacturing_year,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * @param {{role: string, userId: string, username: string, form: object}} args
 * `form` is the Owner & Vehicle Details payload (ownerName, mobile, email,
 * odometer, registrationNumber, state, registrationDate, product, make,
 * model, variant, manufacturingYear).
 */
export function createClaim({ role, userId, username, form }) {
    const id = randomUUID();
    const claimNumber = generateClaimNumber();

    db.prepare(`
        INSERT INTO claims (
            id, claim_number, role, created_by_user_id, created_by_username,
            owner_name, mobile, email, odometer, registration_number, state,
            registration_date, product, make, model, variant, manufacturing_year
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        id, claimNumber, role, userId, username,
        form.ownerName, form.mobile || null, form.email || null, form.odometer || null,
        form.registrationNumber, form.state || null, form.registrationDate || null,
        form.product || null, form.make || null, form.model || null,
        form.variant || null, form.manufacturingYear || null
    );

    return findClaimById(id);
}

export function findClaimById(id) {
    return db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
}

/** Claims visible to one portal (role), newest first -- this is the data-isolation boundary between portals. */
export function listClaimsByRole(role) {
    return db.prepare('SELECT * FROM claims WHERE role = ? ORDER BY created_at DESC').all(role);
}
