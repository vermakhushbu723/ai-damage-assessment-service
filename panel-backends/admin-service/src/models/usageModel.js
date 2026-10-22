import { db, nowIso } from '../db/database.js';

// Request counter per day x module x admin -- "API Usage" and the module
// usage table on SaaS Usage.

let stmt;
export function countRequest(module, adminId = '') {
    stmt ??= db.prepare(`INSERT INTO api_usage (day, module, admin_id, requests) VALUES (?, ?, ?, 1)
                         ON CONFLICT(day, module, admin_id) DO UPDATE SET requests = requests + 1`);
    stmt.run(nowIso().slice(0, 10), module, adminId);
}

export const requestsBetween = (fromDay, toDay) =>
    db.prepare('SELECT COALESCE(SUM(requests), 0) AS n FROM api_usage WHERE day >= ? AND day <= ?').get(fromDay, toDay).n;

export const moduleUsageBetween = (fromDay, toDay) =>
    db.prepare(`SELECT module, SUM(requests) AS requests, COUNT(DISTINCT admin_id) AS admins, COUNT(DISTINCT day) AS days
                FROM api_usage WHERE day >= ? AND day <= ? AND admin_id <> '' GROUP BY module`).all(fromDay, toDay);
