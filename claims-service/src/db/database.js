// SQLite via Node's built-in node:sqlite module -- same choice as
// ../../server and ../../auth-service, for the same reason (no native
// compilation step). Separate DB file from both of those.

import { DatabaseSync } from 'node:sqlite';
import { settings } from '../config.js';

export const db = new DatabaseSync(settings.databaseFile);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
    -- One row = one claim, created from the Owner & Vehicle Details form.
    -- Scoped by (role, created_by_user_id) so each portal only ever sees
    -- its own claims -- see routes/claims.js's GET / filtering by
    -- req.auth.role. "role" here is the SAME role value issued in the
    -- creating user's login token (see ../../auth-service/src/schemas/roles.js).
    CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,
        claim_number TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        created_by_username TEXT NOT NULL,

        -- Owner & Vehicle Details form fields
        owner_name TEXT NOT NULL,
        mobile TEXT,
        email TEXT,
        odometer TEXT,
        registration_number TEXT NOT NULL,
        state TEXT,
        registration_date TEXT,
        product TEXT,
        make TEXT,
        model TEXT,
        variant TEXT,
        manufacturing_year TEXT,

        -- Dashboard/claim-list display fields
        insurer_name TEXT NOT NULL DEFAULT 'New India Assurance',
        status TEXT NOT NULL DEFAULT 'Pending', -- 'Pending' | 'Completed'
        survey_date TEXT,
        amount TEXT,

        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_claims_role ON claims(role);
    CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
    CREATE INDEX IF NOT EXISTS idx_claims_created_by ON claims(created_by_user_id);
`);

// Lightweight migration for columns added after the table already existed
// in some environments -- node:sqlite has no migration framework, so this
// just checks PRAGMA table_info and ALTERs if missing. Safe to run on every
// startup (idempotent).
//   documents_json        -- Document Upload page's per-document status
//                             (id -> { label, submitted, sides/count }),
//                             set via PATCH /api/v1/claims/:id
//   captured_angles_json  -- Photo Capture / Add Damage Photos pages'
//                             per-angle capture status (angle id -> true).
//                             NOTE: this stores completion status only, not
//                             the photo bytes themselves -- captured images
//                             still live in the browser (localStorage data
//                             URLs), same as before this backend existed.
const existingColumns = db.prepare('PRAGMA table_info(claims)').all().map((c) => c.name);
if (!existingColumns.includes('documents_json')) {
    db.exec('ALTER TABLE claims ADD COLUMN documents_json TEXT');
}
if (!existingColumns.includes('captured_angles_json')) {
    db.exec('ALTER TABLE claims ADD COLUMN captured_angles_json TEXT');
}
