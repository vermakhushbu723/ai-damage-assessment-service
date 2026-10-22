import { randomUUID } from 'node:crypto';
import { db } from '../db/database.js';

function generateClaimNumber() {
    // CLM + 10 digits, e.g. CLM1737654321. Collisions are astronomically
    // unlikely (ms timestamp + this runs on a single instance for now),
    // and the UNIQUE constraint on claim_number is the real backstop.
    return `CLM${Date.now()}`;
}

/** Maps a DB row (snake_case) to the shape the frontend expects (camelCase, plus a derived `vehicle` string). */
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
        // Full form data -- DashboardPage/ClaimListCard only read the
        // fields above; InspectionDetailsPage/DamageReviewPage (the
        // survey flow, see routes/claims.js's GET /:id) read these too.
        mobile: row.mobile,
        email: row.email,
        odometer: row.odometer,
        registrationDate: row.registration_date,
        product: row.product,
        make: row.make,
        model: row.model,
        variant: row.variant,
        manufacturingYear: row.manufacturing_year,
        // Document Upload / Photo Capture progress -- see database.js's
        // migration comment for what these do and don't store.
        documents: row.documents_json ? JSON.parse(row.documents_json) : {},
        capturedAngles: row.captured_angles_json ? JSON.parse(row.captured_angles_json) : {},
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

/** Same as findClaimById, but only returns the row if it belongs to `role` -- the enforcement point for portal data isolation on single-claim routes (GET/PATCH/:id, POST /:id/submit). */
export function findClaimByIdForRole(id, role) {
    return db.prepare('SELECT * FROM claims WHERE id = ? AND role = ?').get(id, role);
}

/** Claims visible to one portal (role), newest first -- this is the data-isolation boundary between portals. */
export function listClaimsByRole(role) {
    return db.prepare('SELECT * FROM claims WHERE role = ? ORDER BY created_at DESC').all(role);
}

/**
 * Partial update -- only the keys present in `patch` are touched.
 * @param {string} id
 * @param {{documents?: object, capturedAngles?: object}} patch
 */
export function updateClaimProgress(id, patch) {
    const sets = [];
    const values = [];
    if (patch.documents !== undefined) {
        sets.push('documents_json = ?');
        values.push(JSON.stringify(patch.documents));
    }
    if (patch.capturedAngles !== undefined) {
        sets.push('captured_angles_json = ?');
        values.push(JSON.stringify(patch.capturedAngles));
    }
    if (sets.length === 0) return findClaimById(id);

    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
    db.prepare(`UPDATE claims SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return findClaimById(id);
}

/** Marks a claim Completed with today's survey date -- the "Submit Survey" action on DamageReviewPage. */
export function markClaimSubmitted(id) {
    db.prepare(`
        UPDATE claims
        SET status = 'Completed',
            survey_date = strftime('%Y-%m-%d', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
    `).run(id);
    return findClaimById(id);
}
