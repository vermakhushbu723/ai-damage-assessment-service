// SQLite via Node's built-in node:sqlite (no native build step), same choice
// as ../../superadmin-service. This file is the whole schema of the Admin
// portal; `CREATE ... IF NOT EXISTS` keeps startup idempotent.

import { existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { settings } from '../config.js';

// The file was called admin.db before it got the ServiceProvider name; an
// existing one (with its -wal/-shm companions) is renamed once on startup so
// no data is lost on upgrade.
const legacyFile = join(dirname(settings.databaseFile), 'admin.db');
if (legacyFile !== settings.databaseFile && !existsSync(settings.databaseFile) && existsSync(legacyFile)) {
    for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(legacyFile + suffix)) renameSync(legacyFile + suffix, settings.databaseFile + suffix);
    }
    console.log(`[admin-service] Renamed ${legacyFile} -> ${settings.databaseFile}`);
}
export const db = new DatabaseSync(settings.databaseFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
    -- People who sign in to the Admin portal.
    CREATE TABLE IF NOT EXISTS admins (
        id TEXT PRIMARY KEY,                      -- ADM-101, ...
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        mobile TEXT,
        status TEXT NOT NULL DEFAULT 'Active',    -- Active | Suspended
        password_hash TEXT NOT NULL,
        failed_logins INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_admins_email ON admins(lower(email));

    -- Roles & Permissions (and the role list of Create Users).
    CREATE TABLE IF NOT EXISTS roles (
        key TEXT PRIMARY KEY,                     -- national-manager, claim-handler, ...
        name TEXT NOT NULL,
        short TEXT,
        form_name TEXT,                           -- "CSM/Handler" on the Create Users form
        chart_label TEXT,                         -- dashboard bar label
        level INTEGER NOT NULL,                   -- L1 national ... L5 call center
        extra TEXT,                               -- which role-specific block the Create Users form shows
        permissions TEXT NOT NULL,                -- JSON { module: { view, edit, create, approve, download } }
        is_system INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_name ON roles(lower(name));

    -- Users created in Create Users (claim handlers, managers, surveyors, ...).
    -- Columns hold what is searched / unique; every other form field is in data (JSON).
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,                      -- USR-1001, ...
        user_id TEXT NOT NULL,                    -- login name
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        employee_id TEXT NOT NULL,
        contact TEXT,
        role_key TEXT NOT NULL REFERENCES roles(key),
        status TEXT NOT NULL,                     -- Active | Inactive | On Leave | Suspended | Resigned | Pending
        organization TEXT,
        data TEXT NOT NULL,                       -- JSON: the rest of the Create Users form
        password_hash TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 1,
        password_reset_at TEXT,
        last_reset_link_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_user_id ON users(lower(user_id));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(lower(email));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_id ON users(lower(employee_id));

    -- One-time "Send Link" password reset tokens (only the SHA-256 is stored).
    CREATE TABLE IF NOT EXISTS reset_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
    );

    -- Configuration lists edited in the portal (branches, document templates,
    -- communication rules/templates/channels, fraud rules, authority matrix,
    -- integrations, ...). One row per item; the collection decides its shape
    -- (validated in routes/resources.js).
    CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,                       -- JSON
        position INTEGER NOT NULL,                -- display order (higher = newer when listed newest first)
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, id)
    );

    -- Single configuration documents: dashboard config (claim flow / approval /
    -- journey switches, approval rules), fraud routing, recommendation engine,
    -- stage TAT, system update switches, compliance.
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,                      -- JSON
        updated_at TEXT NOT NULL
    );

    -- Claims pushed by the claim systems (POST /claims/ingest).
    CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,                      -- CLM-...
        handler_id TEXT,
        stage TEXT NOT NULL,
        region TEXT,
        branch_id TEXT,
        amount INTEGER,
        intimated_at TEXT NOT NULL,
        data TEXT NOT NULL,                       -- JSON: customer, type, slaDays, vehicleNo, ...
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claims_handler ON claims(handler_id);

    -- "Recent Configuration Changes" (dashboard, bell, Audit Logs).
    CREATE TABLE IF NOT EXISTS changes (
        id TEXT PRIMARY KEY,                      -- CHG-1001, ...
        changed_by TEXT NOT NULL,
        changed_by_id TEXT,
        module TEXT NOT NULL,
        change TEXT NOT NULL,
        old_value TEXT NOT NULL,
        new_value TEXT NOT NULL,
        ip TEXT,
        device TEXT,
        changed_on TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changes_on ON changes(changed_on);

    -- Security / session events (sign-in, failed sign-in, password reset, export, ...).
    CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor_id TEXT,
        user TEXT NOT NULL,
        role TEXT,
        update_text TEXT NOT NULL,                -- "Update" column
        reference TEXT NOT NULL,                  -- Login | Failed Login | Password Reset | Exported | Downloaded | ...
        module TEXT NOT NULL,
        status TEXT NOT NULL,                     -- Success | Failed
        detail TEXT,
        ip TEXT,
        device TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_events(at);

    -- Data Download history; the generated file is kept for DOWNLOAD_TTL_DAYS.
    CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,                      -- DL-1001, ...
        file_name TEXT NOT NULL,
        data_type TEXT NOT NULL,
        format TEXT NOT NULL,
        params TEXT NOT NULL,                     -- JSON { from, to, region }
        rows INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_by TEXT,
        created_by_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    );

    -- Pre-inspections submitted from the Pre-Inspection Agent app (preinspection_agent_app).
    -- Columns hold what is listed / filtered; the rest of the app's form is in data (JSON).
    CREATE TABLE IF NOT EXISTS inspections (
        id TEXT PRIMARY KEY,                      -- PI-100001, ... (the app's "PI Ref. Number")
        agent_id TEXT NOT NULL REFERENCES users(id),
        agent_role TEXT NOT NULL,                 -- agent | surveyor (login tab)
        status TEXT NOT NULL DEFAULT 'Draft',     -- Assigned (by admin, not started) | Draft (agent working) | Submitted | Approved | Rejected
        registration_number TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        workflow TEXT,                            -- damage | others (photo-capture branch)
        data TEXT NOT NULL,                       -- JSON: owner & vehicle form, recommendation, declarations, location
        submitted_at TEXT,
        repair_submitted_at TEXT,
        reviewed_at TEXT,
        reviewed_by TEXT,
        review_remarks TEXT,
        assigned_by TEXT,                         -- admin name when assigned from the panel
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_inspections_agent ON inspections(agent_id);
    CREATE INDEX IF NOT EXISTS idx_inspections_status ON inspections(status);

    -- Files of an inspection, stored on disk under UPLOADS_DIR/<inspection id>/.
    -- (inspection, kind, slot) is unique: re-capturing a slot replaces the file.
    CREATE TABLE IF NOT EXISTS inspection_media (
        id TEXT PRIMARY KEY,                      -- random
        inspection_id TEXT NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,                       -- document | photo | video | signature | reinspection | repair
        slot TEXT NOT NULL,                       -- e.g. rc_front, front-side, walkaround, customer, bill
        mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        file_name TEXT NOT NULL,                  -- relative to UPLOADS_DIR
        latitude REAL,
        longitude REAL,
        captured_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (inspection_id, kind, slot)
    );

    -- Contact enquiries from the IBima Assist app (ibima-assist-app, the website's
    -- Android build) -- same fields as the website's Contact form.
    CREATE TABLE IF NOT EXISTS enquiries (
        id TEXT PRIMARY KEY,                      -- ENQ-1001, ...
        name TEXT NOT NULL,
        organisation TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT NOT NULL,
        org_type TEXT,
        interest TEXT,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',       -- new | contacted | qualified | closed | spam
        notes TEXT,
        source TEXT NOT NULL DEFAULT 'app',       -- app | website (page path optional in source_page)
        source_page TEXT,
        ip TEXT,
        user_agent TEXT,
        handled_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_enquiries_created ON enquiries(created_at);

    -- Documents DMS: files the admin attaches to an enquiry (proposal, agreement, KYC, ...).
    -- Stored on disk under UPLOADS_DIR/<enquiry id>/ like the pre-inspection files.
    CREATE TABLE IF NOT EXISTS enquiry_files (
        id TEXT PRIMARY KEY,                      -- random
        enquiry_id TEXT NOT NULL REFERENCES enquiries(id) ON DELETE CASCADE,
        doc_type TEXT NOT NULL,                   -- proposal | agreement | kyc | other
        original_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        file_name TEXT NOT NULL,                  -- relative to UPLOADS_DIR
        uploaded_by TEXT,
        created_at TEXT NOT NULL
    );

    -- Requests per day and module ("API Usage" / module usage on SaaS Usage).
    CREATE TABLE IF NOT EXISTS api_usage (
        day TEXT NOT NULL,
        module TEXT NOT NULL,
        admin_id TEXT NOT NULL DEFAULT '',
        requests INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, module, admin_id)
    );
`);

// Columns added after the first deploy (node:sqlite has no migrations):
// sign-in tracking for users who log in to the field app.
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
for (const [col, type] of [['failed_logins', 'INTEGER NOT NULL DEFAULT 0'], ['locked_until', 'TEXT'], ['last_login_at', 'TEXT']]) {
    if (!userColumns.has(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
}

export const nowIso = () => new Date().toISOString();

/** Runs fn inside BEGIN/COMMIT; rolls back on any error. */
export function transaction(fn) {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

export const parseJson = (text, fallback) => {
    try {
        return text == null ? fallback : JSON.parse(text);
    } catch {
        return fallback;
    }
};
