import { db, nowIso, parseJson } from '../db/database.js';
import { DEFAULT_SETTINGS } from '../db/defaults.js';

// Single configuration documents (table `settings`), e.g. `config`, `routing`.
export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

export function getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    const fallback = structuredClone(DEFAULT_SETTINGS[key]);
    if (!row) return fallback;
    const saved = parseJson(row.value, fallback);
    // Keys added to the defaults later are filled in.
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...fallback, ...saved } : fallback;
}

export function setSetting(key, value) {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, JSON.stringify(value), nowIso());
    return getSetting(key);
}

export const settingExists = (key) => !!db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
