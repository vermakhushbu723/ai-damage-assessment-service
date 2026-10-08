// SQLite via Node's built-in node:sqlite (no native build step), same choice
// as ../../auth-service and ../../server. This file is the whole schema of
// the super admin console; `CREATE ... IF NOT EXISTS` keeps startup idempotent.

import { DatabaseSync } from 'node:sqlite';
import { settings } from '../config.js';

export const db = new DatabaseSync(settings.databaseFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
    -- People who sign in to the Super Admin console ("Admin Users" page).
    -- scope: 'all' (master) | 'saas' | 'serviceProvider' -- which organizations they manage.
    CREATE TABLE IF NOT EXISTS admin_users (
        id TEXT PRIMARY KEY,                      -- ADM-101, ADM-102, ...
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        role TEXT NOT NULL,                       -- a row of roles.name
        scope TEXT NOT NULL DEFAULT 'all',
        status TEXT NOT NULL DEFAULT 'Active',    -- Active | Pending | Suspended
        mfa INTEGER NOT NULL DEFAULT 0,
        password_hash TEXT NOT NULL,
        failed_logins INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(lower(email));

    -- Roles & Permissions: one matrix (page -> {view, edit, create, approve, download}) per role.
    CREATE TABLE IF NOT EXISTS roles (
        name TEXT PRIMARY KEY,
        permissions TEXT NOT NULL,                -- JSON
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    -- SaaS Plans & Subscription catalog.
    CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,                      -- starter | professional | enterprise | custom | ...
        name TEXT NOT NULL,
        price INTEGER,                            -- INR / month; NULL = custom pricing
        price_label TEXT,
        user_limit TEXT NOT NULL,
        features TEXT NOT NULL,                   -- JSON array of strings
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
    );

    -- Organizations/Vendors (Insurer / Broker / Surveyor / Workshop).
    CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,                      -- ORG-1001, ORG-1002, ...
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Active',    -- Active | Pending | Suspended | Expired
        id_type TEXT NOT NULL DEFAULT 'Working',  -- Pilot | Working
        service_model TEXT NOT NULL,              -- SaaS | Service Provider
        plan_id TEXT REFERENCES plans(id),
        subscription_start TEXT,
        subscription_expiry TEXT,
        admin_login_id TEXT,
        claims_count INTEGER NOT NULL DEFAULT 0,
        workflow TEXT NOT NULL DEFAULT '{}',      -- JSON: auto-assigned claim workflow
        settings TEXT NOT NULL DEFAULT '{}',      -- JSON: billing cycle, modules, channels, ...
        form TEXT NOT NULL DEFAULT '{}',          -- JSON: every field of the creation form (no passwords)
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_org_service_model ON organizations(service_model);

    -- Users: people inside organizations (incl. each organization's own admin login).
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,                      -- USR-1001 ... or ORG-1001-ADM for an org's admin
        organization_id TEXT NOT NULL REFERENCES organizations(id),
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        phone TEXT,
        role TEXT NOT NULL,
        branch TEXT,
        platform TEXT,                            -- Mobile | Web | Both
        status TEXT NOT NULL DEFAULT 'Active',    -- Active | Pending | Inactive | Suspended
        password_hash TEXT NOT NULL,
        must_change_password INTEGER NOT NULL DEFAULT 1,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_org ON users(organization_id);

    -- "Send Link" tokens (only a hash is stored).
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        actor_id TEXT,
        actor_name TEXT NOT NULL,
        actor_role TEXT,
        action TEXT NOT NULL,                     -- Created | Updated | Deleted | Login | Exported | Downloaded ...
        module TEXT NOT NULL,                     -- Organizations | Users | Settings | System ...
        status TEXT NOT NULL DEFAULT 'Success',   -- Success | Failed
        detail TEXT,
        ip TEXT,
        device TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(timestamp);

    -- Service Model page.
    CREATE TABLE IF NOT EXISTS service_models (
        id TEXT PRIMARY KEY,                      -- SM-101, SM-102, ...
        name TEXT NOT NULL,
        service_type TEXT NOT NULL,
        applicable_for TEXT NOT NULL,
        description TEXT,
        sla_hours INTEGER NOT NULL,
        working_hours TEXT NOT NULL,
        escalation_after TEXT NOT NULL,
        escalation_to TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Active',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    -- Claim Workflow & Role Configuration: one row per mode (saas | serviceProvider).
    CREATE TABLE IF NOT EXISTS workflow_configs (
        mode TEXT PRIMARY KEY,
        config TEXT NOT NULL,                     -- JSON: stages, rules, overview, triggers, autoRoles, activatedAt
        updated_by TEXT,
        updated_at TEXT NOT NULL
    );

    -- Claims shown in the reports. Pushed in by the claim systems (POST /claims/ingest).
    CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,                      -- the claim number from the source system
        organization_id TEXT REFERENCES organizations(id),
        customer TEXT NOT NULL,
        claim_type TEXT,
        product_type TEXT,
        handler TEXT,
        amount INTEGER NOT NULL DEFAULT 0,
        sla_days INTEGER,
        status TEXT NOT NULL,                     -- Intimation | Survey | AI ILA | ILA | FLA | Settled | Rejected ...
        intimation_date TEXT NOT NULL,
        settled_at TEXT,
        branch TEXT,
        region TEXT,
        state TEXT,
        source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claims_org ON claims(organization_id);
    CREATE INDEX IF NOT EXISTS idx_claims_date ON claims(intimation_date);

    -- Data Download history; the generated CSV is kept until it expires.
    CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        data_type TEXT NOT NULL,
        format TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '{}',
        row_count INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        content TEXT,                             -- NULL once expired
        created_by TEXT,
        created_by_name TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
    );

    -- System Settings > API Integration.
    CREATE TABLE IF NOT EXISTS integrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL,
        environment TEXT NOT NULL,
        endpoint TEXT,
        api_key TEXT,
        status TEXT NOT NULL DEFAULT 'Not Configured',   -- Not Configured | Connected | Warning | Failed
        last_response_ms INTEGER,
        last_error TEXT,
        last_sync TEXT,
        updated_at TEXT NOT NULL
    );

    -- System Settings switches + version info (key -> JSON value).
    CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );

    -- System Update / Audit & Compliance activity table and deployment history.
    CREATE TABLE IF NOT EXISTS system_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        user TEXT NOT NULL,
        activity TEXT NOT NULL,
        module TEXT NOT NULL,                     -- API Integration | System Update | Compliance
        status TEXT NOT NULL                      -- Success | Failed | Approval Log
    );
    CREATE TABLE IF NOT EXISTS deployments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL,
        date TEXT NOT NULL,
        by_name TEXT NOT NULL,
        status TEXT NOT NULL
    );

    -- Requests per day (SaaS Usage Report "API Usage").
    CREATE TABLE IF NOT EXISTS api_usage (
        day TEXT PRIMARY KEY,                     -- YYYY-MM-DD
        requests INTEGER NOT NULL DEFAULT 0
    );
`);

/** Run fn inside a transaction (node:sqlite has no helper for it). */
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

export const nowIso = () => new Date().toISOString();
