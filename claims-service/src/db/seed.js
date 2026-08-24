// Seeds a handful of sample claims per portal so each one's Dashboard has
// real data to fetch/display out of the box -- same idea as
// ../../server/src/db/seed.js (sample parts rates) and
// ../../auth-service/src/db/seed.js (demo logins). Illustrative demo data
// only, attributed to that portal's demo login (see ../../auth-service's
// README.md) -- there's no foreign key to auth-service's users table (they're
// separate DBs/services), created_by_user_id here is just an attribution
// string, not enforced.
//
// Each portal's claims are entirely separate rows scoped by `role` -- this
// is what actually keeps claim_workshop's data and claim_surveyor's data
// apart (see routes/claims.js's role-scoped queries), same as their logins
// are separate accounts in auth-service.

import { randomUUID } from 'node:crypto';
import { db } from './database.js';

// role -> { userId, username, claims: [...] }. Add a new portal's seed data
// by adding one more entry here -- nothing else needs to change.
const SEED_BY_ROLE = {
    claim_workshop: {
        userId: 'seed-workshop1',
        username: 'workshop1',
        claimNumberBase: 1000000000,
        claims: [
            { ownerName: 'Rahul Sharma', mobile: '9876500001', email: 'rahul.sharma@example.com', odometer: '18500', registrationNumber: 'OD02AB1234', state: 'Odisha', registrationDate: '12-03-2022', product: 'Private Car', make: 'Maruti Suzuki', model: 'Swift Dzire', variant: 'Z4', manufacturingYear: '04-2022', status: 'Pending' },
            { ownerName: 'Priya Patel', mobile: '9876500002', email: 'priya.patel@example.com', odometer: '32100', registrationNumber: 'MH12CD5678', state: 'Maharashtra', registrationDate: '05-07-2021', product: 'Private Car', make: 'Hyundai', model: 'Creta', variant: 'Z6', manufacturingYear: '07-2021', status: 'Completed' },
            { ownerName: 'Amit Kumar', mobile: '9876500003', email: 'amit.kumar@example.com', odometer: '9800', registrationNumber: 'DL03EF9012', state: 'Delhi', registrationDate: '20-11-2023', product: 'Private Car', make: 'Honda', model: 'City', variant: 'Z2', manufacturingYear: '11-2023', status: 'Pending' },
            { ownerName: 'Sneha Reddy', mobile: '9876500004', email: 'sneha.reddy@example.com', odometer: '46200', registrationNumber: 'KA05GH3456', state: 'Karnataka', registrationDate: '02-02-2020', product: 'Private Car', make: 'Tata', model: 'Nexon', variant: 'Z8', manufacturingYear: '02-2020', status: 'Completed' },
            { ownerName: 'Vikram Iyer', mobile: '9876500005', email: 'vikram.iyer@example.com', odometer: '61300', registrationNumber: 'TN07IJ7890', state: 'Tamil Nadu', registrationDate: '15-08-2019', product: 'Private Car', make: 'Toyota', model: 'Innova', variant: 'Z8L', manufacturingYear: '08-2019', status: 'Completed' },
            { ownerName: 'Neha Joshi', mobile: '9876500006', email: 'neha.joshi@example.com', odometer: '5400', registrationNumber: 'GJ01KL2345', state: 'Gujarat', registrationDate: '28-01-2024', product: 'Private Car', make: 'Kia', model: 'Seltos', variant: 'Z6', manufacturingYear: '01-2024', status: 'Pending' },
        ],
    },
    claim_surveyor: {
        userId: 'seed-surveyor1',
        username: 'surveyor1',
        claimNumberBase: 2000000000,
        claims: [
            { ownerName: 'Arjun Das', mobile: '9876500007', email: 'arjun.das@example.com', odometer: '27400', registrationNumber: 'WB04MN6789', state: 'West Bengal', registrationDate: '10-09-2021', product: 'Private Car', make: 'Mahindra', model: 'XUV700', variant: 'Z8', manufacturingYear: '09-2021', status: 'Pending' },
            { ownerName: 'Lakshmi Rao', mobile: '9876500008', email: 'lakshmi.rao@example.com', odometer: '15200', registrationNumber: 'AP09OP0123', state: 'Andhra Pradesh', registrationDate: '02-04-2023', product: 'Private Car', make: 'Renault', model: 'Kwid', variant: 'Z2', manufacturingYear: '04-2023', status: 'Completed' },
            { ownerName: 'Rohit Singh', mobile: '9876500009', email: 'rohit.singh@example.com', odometer: '38900', registrationNumber: 'RJ14QR4567', state: 'Rajasthan', registrationDate: '18-12-2020', product: 'Private Car', make: 'Ford', model: 'EcoSport', variant: 'Z4', manufacturingYear: '12-2020', status: 'Completed' },
            { ownerName: 'Anjali Verma', mobile: '9876500010', email: 'anjali.verma@example.com', odometer: '6700', registrationNumber: 'UP32ST8901', state: 'Uttar Pradesh', registrationDate: '25-05-2024', product: 'Private Car', make: 'Volkswagen', model: 'Polo', variant: 'Z6', manufacturingYear: '05-2024', status: 'Pending' },
            { ownerName: 'Gurpreet Kaur', mobile: '9876500011', email: 'gurpreet.kaur@example.com', odometer: '52300', registrationNumber: 'PB10UV2345', state: 'Punjab', registrationDate: '14-02-2019', product: 'Private Car', make: 'Maruti Suzuki', model: 'Baleno', variant: 'Z8', manufacturingYear: '02-2019', status: 'Completed' },
            { ownerName: 'Suresh Yadav', mobile: '9876500012', email: 'suresh.yadav@example.com', odometer: '11800', registrationNumber: 'HR26WX6789', state: 'Haryana', registrationDate: '30-07-2023', product: 'Private Car', make: 'Hyundai', model: 'Venue', variant: 'Z4', manufacturingYear: '07-2023', status: 'Pending' },
        ],
    },
};

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

    for (const [role, { userId, username, claimNumberBase, claims }] of Object.entries(SEED_BY_ROLE)) {
        let seededCount = 0;
        claims.forEach((c, i) => {
            if (existsStmt.get(role, c.registrationNumber)) return;
            const id = randomUUID();
            // Space out claim numbers deterministically per role (no
            // Date.now() dependency needed) so they never collide with each
            // other or across roles, and sort newest-first sensibly.
            const claimNumber = `CLM${claimNumberBase + i}`;
            insert.run(
                id, claimNumber, role, userId, username,
                c.ownerName, c.mobile, c.email, c.odometer, c.registrationNumber, c.state,
                c.registrationDate, c.product, c.make, c.model, c.variant, c.manufacturingYear,
                c.status
            );
            seededCount++;
        });
        if (seededCount > 0) {
            console.log(`[claims-service] seeded ${seededCount} sample claim(s) for role=${role}`);
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    seedSampleClaims();
    console.log('[claims-service] seed complete.');
}
