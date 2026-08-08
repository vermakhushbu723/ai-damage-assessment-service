// SQLite via Node's built-in node:sqlite module (stable since Node 22.5,
// no native compilation/build step -- unlike better-sqlite3, which needs a
// working Python + C++ toolchain to install and was the whole reason this
// service moved off Python to begin with). Requires Node >= 22.5, see
// package.json "engines". Synchronous, embedded, no separate DB server to
// run. Replaces SQLAlchemy (app/db/database.py + app/db/models.py) from the
// old Python service; same two tables, same columns.

import { DatabaseSync } from 'node:sqlite';
import { settings } from '../config.js';

export const db = new DatabaseSync(settings.databaseFile);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS parts_rates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        make TEXT NOT NULL,
        model TEXT NOT NULL,
        year_from INTEGER NOT NULL,
        year_to INTEGER NOT NULL,
        part TEXT NOT NULL,
        region TEXT NOT NULL DEFAULT 'default',
        part_cost REAL NOT NULL,
        labor_cost REAL NOT NULL,
        paint_consumables_cost REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_parts_rates_make ON parts_rates(make);
    CREATE INDEX IF NOT EXISTS idx_parts_rates_model ON parts_rates(model);
    CREATE INDEX IF NOT EXISTS idx_parts_rates_part ON parts_rates(part);

    -- One row = one handler correction to an AI output. This *is* the
    -- retraining queue described in docs/ARCHITECTURE.md -- a scheduled job
    -- reads unconsumed rows here, exports them into the annotation format
    -- YOLO11 fine-tuning expects, and kicks off a training run once the
    -- volume threshold (settings.retrainVolumeThreshold) is hit.
    CREATE TABLE IF NOT EXISTS corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id TEXT NOT NULL,
        photo_id TEXT NOT NULL,
        vehicle_type TEXT NOT NULL,
        ai_output TEXT NOT NULL,
        corrected_output TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        consumed_by_retraining_run TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_corrections_claim ON corrections(claim_id);
    CREATE INDEX IF NOT EXISTS idx_corrections_photo ON corrections(photo_id);

    -- One row = one photo uploaded via Annotation Studio. The photo file
    -- itself and its YOLO label (.txt, once annotated) live on disk under
    -- settings.trainingRawPoolDir/<vehicle_type>/{images,labels}/<id>.* --
    -- this row is just the queryable index over that raw pool, letting the
    -- UI list photos and know which are still pending annotation.
    CREATE TABLE IF NOT EXISTS annotation_photos (
        id TEXT PRIMARY KEY,
        vehicle_type TEXT NOT NULL,
        original_filename TEXT NOT NULL,
        stored_filename TEXT NOT NULL,
        image_width INTEGER,
        image_height INTEGER,
        annotated INTEGER NOT NULL DEFAULT 0,
        annotations_json TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        annotated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_annotation_photos_vehicle ON annotation_photos(vehicle_type);
`);
