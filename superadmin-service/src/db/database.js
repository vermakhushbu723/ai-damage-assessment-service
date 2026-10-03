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
