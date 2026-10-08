import { db, nowIso, parseJson, transaction } from './database.js';
import { settings } from '../config.js';
import { DEFAULT_ROLES, DEFAULT_SETTINGS, DEFAULT_RECORDS } from './defaults.js';
import { countAdmins, insertAdmin } from '../models/adminModel.js';
import { findRole, insertRole } from '../models/roleModel.js';
import { insertRecord } from '../models/recordModel.js';
import { getSetting, settingExists, setSetting } from '../models/settingsModel.js';
import { purgeOlderThan } from '../models/auditModel.js';
import { dropExpiredContent } from '../models/downloadModel.js';
import { hashPassword } from '../utils/password.js';
import { generatePassword } from '../utils/ids.js';
import { checkPassword, normalizePhone } from '../utils/http.js';

// First start only: the admin login, the default roles, configuration
// documents and configuration lists. Each part is written once -- a list the
// admin later empties is not refilled on restart (tracked in `__seeded`).

const SEEDED_KEY = '__seeded';

function seededParts() {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SEEDED_KEY);
    return new Set(parseJson(row?.value, []));
}

function markSeeded(parts) {
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(SEEDED_KEY, JSON.stringify([...parts]), nowIso());
}

export function bootstrap() {
    if (!countAdmins()) {
        const { name, email, mobile } = settings.bootstrapAdmin;
        let { password } = settings.bootstrapAdmin;
        let generated = false;
        if (password) checkPassword(password, 'BOOTSTRAP_ADMIN_PASSWORD');
        else {
            password = generatePassword();
            generated = true;
        }
        insertAdmin({ id: 'ADM-101', name, email, mobile: normalizePhone(mobile), passwordHash: hashPassword(password) });
        console.log(`[admin-service] Created admin login ${email}${generated ? ` with password: ${password}  (shown once -- save it)` : ''}`);
    }

    const done = seededParts();
    transaction(() => {
        if (!done.has('roles')) {
            for (const role of DEFAULT_ROLES) if (!findRole(role.key)) insertRole({ ...role, isSystem: true });
            done.add('roles');
        }
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (!settingExists(key)) setSetting(key, DEFAULT_SETTINGS[key]);
        }
        for (const [collection, items] of Object.entries(DEFAULT_RECORDS)) {
            if (done.has(collection)) continue;
            for (const item of items) insertRecord(collection, item);
            done.add(collection);
        }
        if (!done.has('deployments')) {
            insertRecord('deployments', { id: 'DP-1001', version: String(settings.appVersion).replace(/^v/i, ''), at: nowIso(), by: 'System', notes: 'Initial deployment' });
            done.add('deployments');
        }
        markSeeded(done);
    });
}

/** Retention policy + expired download files. Runs on start and every 6 hours. */
export function housekeeping() {
    try {
        purgeOlderThan(getSetting('compliance').retention);
        dropExpiredContent();
    } catch (err) {
        console.error('[admin-service] housekeeping failed:', err.message);
    }
}
