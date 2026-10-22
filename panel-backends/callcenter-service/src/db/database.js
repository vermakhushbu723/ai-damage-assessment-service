// SQLite via Node's built-in node:sqlite (no native build step), same choice
// as ../../admin-service. This file is the whole schema of the call-center
// portal; `CREATE ... IF NOT EXISTS` keeps startup idempotent.
//
// People are NOT stored here: users, handlers and surveyors live in
// admin-service (Admin > Create Users). Rows keep their id + name as they were
// when the action happened.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { settings } from '../config.js';

mkdirSync(dirname(settings.databaseFile), { recursive: true });
export const db = new DatabaseSync(settings.databaseFile);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
    -- One row per claim. Searched / listed fields are columns; the intimation
    -- form itself is the JSON in "intimation".
    CREATE TABLE IF NOT EXISTS claims (
        id TEXT PRIMARY KEY,                      -- Assist Claim ID: BIM-YYMMDD-NNNN
        claim_no TEXT NOT NULL UNIQUE,            -- CLM-YYMMDD-NNNN (the id the Admin portal sees)
        status TEXT NOT NULL,                     -- Draft | Open | Closed
        stage TEXT NOT NULL,                      -- next step: intimation | handler-allocation | ... | completed
        priority TEXT NOT NULL DEFAULT 'Medium',  -- High | Medium | Low
        source TEXT,                              -- Call Center | Direct | Chatbot | Website | App
        insured_name TEXT,
        mobile TEXT,
        vehicle_no TEXT,
        policy_no TEXT,
        city TEXT,
        state TEXT,
        handler_id TEXT,
        handler_name TEXT,
        amount INTEGER,                           -- latest assessed amount (AI ILA -> Handler ILA -> payment)
        intimation TEXT NOT NULL,                 -- JSON: the intimation form
        link TEXT NOT NULL DEFAULT '{}',          -- JSON: survey link block of the intimation screen
        created_by TEXT,
        created_by_name TEXT,
        submitted_at TEXT,                        -- intimation submitted (Draft -> Open)
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_claims_submitted ON claims(submitted_at);
    CREATE INDEX IF NOT EXISTS idx_claims_stage ON claims(stage);

    -- Per-claim documents of the later screens (claim details, liability,
    -- payment, paybill, AI review). One JSON document per key.
    CREATE TABLE IF NOT EXISTS claim_docs (
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        key TEXT NOT NULL,                        -- details | liability | payment | paybill | aiReview
        data TEXT NOT NULL,
        updated_by TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (claim_id, key)
    );

    -- Everything that happened to a claim: stage completions (stage tracker),
    -- handler / surveyor history, remarks and the Claim Audit Trail.
    CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,                       -- stage | handler | surveyor | remark | audit
        action TEXT NOT NULL,
        detail TEXT,
        data TEXT NOT NULL DEFAULT '{}',
        actor_id TEXT,
        actor_name TEXT,
        at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_claim ON events(claim_id, kind);

    -- Spot / final survey allocations.
    CREATE TABLE IF NOT EXISTS surveyor_assignments (
        id TEXT PRIMARY KEY,                      -- SA-1001, ...
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        survey_type TEXT NOT NULL,                -- spot | final
        surveyor_id TEXT NOT NULL,
        surveyor_name TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',          -- surveyor snapshot (type, location, contact)
        status TEXT NOT NULL,                     -- Assigned | Cancelled
        assigned_by TEXT,
        assigned_at TEXT NOT NULL,
        cancelled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sa_claim ON surveyor_assignments(claim_id);

    -- Documents DMS. Files are on disk (UPLOADS_DIR/<claim>/<stored_name>).
    CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,                      -- DOC-1001, ...
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        doc_type TEXT NOT NULL,                   -- rc | dl | claim-form | policy-copy | estimate | vehicle-photos | ...
        file_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        replaced_at TEXT,                         -- set when a newer file of the same type replaced it
        uploaded_by TEXT,
        uploaded_by_name TEXT,
        uploaded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_documents_claim ON documents(claim_id, doc_type);

    -- AI ILA findings, one row per damaged part. "ai" keeps what the model
    -- said, so every reviewer change counts as a correction for retraining.
    CREATE TABLE IF NOT EXISTS damage_items (
        id TEXT PRIMARY KEY,                      -- DMG-1001, ...
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        part TEXT NOT NULL,
        damage_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        action TEXT NOT NULL,
        cost INTEGER NOT NULL,
        confidence INTEGER,                       -- null for parts the reviewer added
        status TEXT NOT NULL,                     -- Pending | Approval | In Review | Rejected
        source TEXT NOT NULL,                     -- ai | reviewer
        ai TEXT,                                  -- JSON: original AI values (null for reviewer rows)
        document_id TEXT,                         -- the survey photo it was found on
        box TEXT,                                 -- JSON {x,y,w,h} in % of the photo
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_damage_claim ON damage_items(claim_id);

    -- Letters issued from Issue Letter.
    CREATE TABLE IF NOT EXISTS letters (
        id TEXT PRIMARY KEY,                      -- LET-YYMMDD-NNN
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        data TEXT NOT NULL,                       -- JSON: form, requirements, body, contact
        channel TEXT NOT NULL,
        created_by TEXT,
        created_by_name TEXT,
        created_at TEXT NOT NULL
    );

    -- Communication History (letters, survey links, email, SMS, notes, responses).
    CREATE TABLE IF NOT EXISTS communications (
        id TEXT PRIMARY KEY,                      -- COM-1001, ...
        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
        direction TEXT NOT NULL,                  -- sent | received | note
        type TEXT NOT NULL,
        tag TEXT NOT NULL,
        reference TEXT,
        description TEXT NOT NULL,
        sub_description TEXT,
        bullets TEXT,                             -- JSON array
        attachment_id TEXT,                       -- documents.id
        person TEXT NOT NULL,
        person_meta TEXT,
        channel TEXT NOT NULL,
        recipient TEXT,                           -- mobile / email it went to
        status TEXT NOT NULL,                     -- Delivered | Sent | Pending | Failed | Received | Noted
        awaiting_response INTEGER NOT NULL DEFAULT 0,
        response_due TEXT,
        letter_id TEXT,
        created_by TEXT,
        at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comm_claim ON communications(claim_id, at);

    -- Claims / communication logs waiting to be pushed to admin-service (/claims/ingest).
    CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,                       -- claim | commLog
        ref TEXT NOT NULL,                        -- claim id / communication id
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (kind, ref)
    );
`);

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
