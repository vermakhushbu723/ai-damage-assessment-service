// Seeds a handful of sample claims for the claim_workshop portal so its
// Dashboard has real data to fetch/display out of the box -- same idea as
// ../../server/src/db/seed.js (sample parts rates) and
// ../../auth-service/src/db/seed.js (demo logins). Illustrative demo data
// only, attributed to the workshop1 demo login (see ../../auth-service's
// README.md) -- there's no foreign key to auth-service's users table (they're
// separate DBs/services), created_by_user_id here is just an attribution
// string, not enforced.

import { randomUUID } from 'node:crypto';
import { db } from './database.js';

const SEED_ROLE = 'claim_workshop';
const SEED_USER_ID = 'seed-workshop1';
const SEED_USERNAME = 'workshop1';

// A representative subset of what used to be the frontend's static
// DEMO_CLAIMS (src/constants/demoClaims.js) -- same shape, now living in
// the DB and reachable via GET /api/v1/claims instead of a hardcoded import.
const SAMPLE_CLAIMS = [
    { ownerName: 'Rahul Sharma', mobile: '9876500001', email: 'rahul.sharma@example.com', odometer: '18500', registrationNumber: 'OD02AB1234', state: 'Odisha', registrationDate: '12-03-2022', product: 'Private Car', make: 'Maruti Suzuki', model: 'Swift Dzire', variant: 'Z4', manufacturingYear: '04-2022', status: 'Pending' },
    { ownerName: 'Priya Patel', mobile: '9876500002', email: 'priya.patel@example.com', odometer: '32100', registrationNumber: 'MH12CD5678', state: 'Maharashtra', registrationDate: '05-07-2021', product: 'Private Car', make: 'Hyundai', model: 'Creta', variant: 'Z6', manufacturingYear: '07-2021', status: 'Completed' },
    { ownerName: 'Amit Kumar', mobile: '9876500003', email: 'amit.kumar@example.com', odometer: '9800', registrationNumber: 'DL03EF9012', state: 'Delhi', registrationDate: '20-11-2023', product: 'Private Car', make: 'Honda', model: 'City', variant: 'Z2', manufacturingYear: '11-2023', status: 'Pending' },
    { ownerName: 'Sneha Reddy', mobile: '9876500004', email: 'sneha.reddy@example.com', odometer: '46200', registrationNumber: 'KA05GH3456', state: 'Karnataka', registrationDate: '02-02-2020', product: 'Private Car', make: 'Tata', model: 'Nexon', variant: 'Z8', manufacturingYear: '02-2020', status: 'Completed' },
    { ownerName: 'Vikram Iyer', mobile: '9876500005', email: 'vikram.iyer@example.com', odometer: '61300', registrationNumber: 'TN07IJ7890', state: 'Tamil Nadu', registrationDate: '15-08-2019', product: 'Private Car', make: 'Toyota', model: 'Innova', variant: 'Z8L', manufacturingYear: '08-2019', status: 'Completed' },
    { ownerName: 'Neha Joshi', mobile: '9876500006', email: 'neha.joshi@example.com', odometer: '5400', registrationNumber: 'GJ01KL2345', state: 'Gujarat', registrationDate: '28-01-2024', product: 'Private Car', make: 'Kia', model: 'Seltos', variant: 'Z6', manufacturingYear: '01-2024', status: 'Pending' },
];

export function seedSampleClaims() {
    const existsStmt = db.prepare('SELECT id FROM claims WHERE role = ? AND registration_number = ?');
    const insert = db.prepare(`
        INSERT INTO claims (
            id, claim_number, role, created_by_user_id, created_by_username,
            owner_name, mobile, email, odometer, registration_number, state,
            registration_date, product, make, model, variant, manufacturing_year,
            status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let seededCount = 0;
    SAMPLE_CLAIMS.forEach((c, i) => {
        if (existsStmt.get(SEED_ROLE, c.registrationNumber)) return;
        const id = randomUUID();
        // Space out claim numbers/timestamps deterministically (no Date.now()
        // dependency needed here beyond a stable per-row offset) so they sort
        // newest-first sensibly and never collide with each other.
        const claimNumber = `CLM${1000000000 + i}`;
        insert.run(
            id, claimNumber, SEED_ROLE, SEED_USER_ID, SEED_USERNAME,
            c.ownerName, c.mobile, c.email, c.odometer, c.registrationNumber, c.state,
            c.registrationDate, c.product, c.make, c.model, c.variant, c.manufacturingYear,
            c.status
        );
        seededCount++;
    });

    if (seededCount > 0) {
        console.log(`[claims-service] seeded ${seededCount} sample claim(s) for role=${SEED_ROLE}`);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    seedSampleClaims();
    console.log('[claims-service] seed complete.');
}
