import { db, nowIso } from '../db/database.js';
import { DEFAULT_SYSTEM_SETTINGS } from '../constants.js';

// ---- key/value settings ----
export function getSystemSettings() {
    const rows = db.prepare('SELECT key, value FROM system_settings').all();
    return { ...DEFAULT_SYSTEM_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) };
}

export function setSystemSettings(patch) {
    const stmt = db.prepare(`INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
                             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
    const now = nowIso();
    for (const [k, v] of Object.entries(patch)) stmt.run(k, JSON.stringify(v), now);
    return getSystemSettings();
}

// ---- activity table (System Update / Audit & Compliance) ----
export function insertActivity({ user, activity, module, status = 'Success' }) {
    db.prepare('INSERT INTO system_activity (date, user, activity, module, status) VALUES (?, ?, ?, ?, ?)').run(nowIso(), user, activity, module, status);
}
export const listActivity = (limit = 500) =>
    db.prepare('SELECT * FROM system_activity ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ id: `ACT-${r.id}`, date: r.date, user: r.user, activity: r.activity, module: r.module, status: r.status }));

// ---- deployments ----
export function insertDeployment({ version, by, status = 'Success' }) {
    db.prepare('INSERT INTO deployments (version, date, by_name, status) VALUES (?, ?, ?, ?)').run(version, nowIso(), by, status);
}
export const listDeployments = () =>
    db.prepare('SELECT * FROM deployments ORDER BY id DESC').all().map((r) => ({ version: r.version, date: r.date, by: r.by_name, status: r.status }));

// ---- API usage counter ----
const usageStmt = () => db.prepare(`INSERT INTO api_usage (day, requests) VALUES (?, 1)
                                    ON CONFLICT(day) DO UPDATE SET requests = requests + 1`);
let stmtCache;
export function countApiRequest() {
    stmtCache ??= usageStmt();
    stmtCache.run(nowIso().slice(0, 10));
}
export const apiRequestsBetween = (fromDay, toDay) =>
    db.prepare('SELECT COALESCE(SUM(requests), 0) AS n FROM api_usage WHERE day >= ? AND day <= ?').get(fromDay, toDay).n;

/** Deletes audit entries older than the retention period ("7 Years" -> 7). */
export function purgeOldAuditLogs(retention) {
    const years = Number(String(retention).split(' ')[0]) || 7;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - years);
    return db.prepare('DELETE FROM audit_logs WHERE timestamp < ?').run(cutoff.toISOString()).changes;
}
