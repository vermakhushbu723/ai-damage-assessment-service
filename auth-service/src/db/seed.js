// Seeds one demo login per portal so the login screens are usable out of
// the box, same way ../../server/src/db/seed.js seeds sample parts rates.
// Replace/extend with real user accounts (or a proper admin "create user"
// screen) before this handles anyone's real credentials -- this is
// illustrative demo data only, clearly labelled as such below.

import { db } from './database.js';
import { hashPassword } from '../utils/password.js';
import { ROLES } from '../schemas/roles.js';

// role -> { username, password, name }. Password is intentionally simple
// and printed to the console on seed -- this is dev/demo data, not meant to
// guard anything real.
const DEMO_USERS = {
    [ROLES.CLAIM_WORKSHOP]: { username: 'workshop1', password: 'Workshop@123', name: 'Demo Claim Workshop' },
    [ROLES.CLAIM_SURVEYOR]: { username: 'surveyor1', password: 'Surveyor@123', name: 'Demo Claim Surveyor' },
    [ROLES.PREINSPECTION_AGENT]: { username: 'agent1', password: 'Agent@123', name: 'Demo Pre-Inspection Agent' },
    [ROLES.PREINSPECTION_SURVEYOR]: { username: 'presurveyor1', password: 'PreSurveyor@123', name: 'Demo Pre-Inspection Surveyor' },
};

export function seedDemoUsers() {
    const insert = db.prepare(
        'INSERT INTO users (id, role, username, password_hash, name) VALUES (?, ?, ?, ?, ?)'
    );
    const existsStmt = db.prepare('SELECT id FROM users WHERE role = ? AND username = ?');

    for (const [role, { username, password, name }] of Object.entries(DEMO_USERS)) {
        if (existsStmt.get(role, username)) continue;
        insert.run(crypto.randomUUID(), role, username, hashPassword(password), name);
        console.log(`[auth-service] seeded demo login -- role=${role} username=${username} password=${password}`);
    }
}

// Allows `npm run seed` as a standalone command in addition to running
// automatically on server start (see src/server.js).
if (import.meta.url === `file://${process.argv[1]}`) {
    seedDemoUsers();
    console.log('[auth-service] seed complete.');
}
