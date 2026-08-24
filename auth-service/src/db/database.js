// SQLite via Node's built-in node:sqlite module -- same choice as
// ../../server/src/db/database.js and for the same reason: no native
// compilation step (unlike better-sqlite3), just Node >= 22.5.
// This is a SEPARATE database file from ../server's -- this service only
// ever stores login credentials + role, nothing about claims/AI results.

import { DatabaseSync } from 'node:sqlite';
import { settings } from '../config.js';

export const db = new DatabaseSync(settings.databaseFile);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
    -- One row = one login for one portal. "role" + "id" together are the
    -- unique key the rest of the system uses to know who's logging in and
    -- keep each portal's data separate -- every issued token carries both
    -- as claims (see ../utils/jwt.js + ../routes/auth.js).
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        last_login_at TEXT
    );

    -- Same username string may legitimately exist under different roles
    -- (e.g. two different people both picking "test1" in two different
    -- portals) -- what must stay unique is the (role, username) pair.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_role_username ON users(role, username);
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
`);
