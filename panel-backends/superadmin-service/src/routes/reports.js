import { Router } from 'express';
import { statSync } from 'node:fs';
import { settings } from '../config.js';
import { authenticate } from '../middleware/authenticate.js';
import { db } from '../db/database.js';
import { apiRequestsBetween } from '../models/systemModel.js';

const router = Router();
router.use(authenticate);

const DAY = 86400_000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const label = (t) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
const pctChange = (now, before) => (before ? Math.round(((now - before) / before) * 1000) / 10 : now ? 100 : 0);
const HEATMAP_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fileSize(path) {
    try {
        return statSync(path).size;
    } catch {
        return 0;
    }
}

/**
 * GET /api/v1/reports/usage -- activity metrics derived from the audit trail
 * and request counters (User Report, SaaS Usage Report, Claim Report alerts chart):
 *  - heatmap: 6 weekdays x 12 two-hour slots, sign-ins over the last 90 days (0..1 + raw counts)
 *  - dauMau: last 9 days, distinct admins signed in that day / in the 30 days ending that day
 *  - sessions / apiRequests: last 30 days vs the 30 days before
 *  - moduleUsage: per audit module over the last 30 days (actions, distinct admins, trend)
 *  - alertsTrend: failed actions per day (last 9 days)
 *  - storageBytes: database + WAL size
 */
router.get('/usage', (_req, res) => {
    const now = Date.now();
    const since90 = new Date(now - 90 * DAY).toISOString();
    const since30 = new Date(now - 30 * DAY).toISOString();
    const since60 = new Date(now - 60 * DAY).toISOString();

    // Heat map from successful sign-ins (local server time).
    const logins = db.prepare("SELECT timestamp, actor_id FROM audit_logs WHERE action = 'Login' AND status = 'Success' AND timestamp >= ?").all(since90);
    const counts = HEATMAP_DAYS.map(() => Array(12).fill(0));
    for (const l of logins) {
        const d = new Date(l.timestamp);
        const weekday = (d.getDay() + 6) % 7; // Mon = 0
        if (weekday > 5) continue; // the design shows Mon-Sat
        counts[weekday][Math.floor(d.getHours() / 2)]++;
    }
    const peak = Math.max(1, ...counts.flat());

    // DAU / MAU for the last 9 days.
    const loginsWithDay = logins.map((l) => ({ day: isoDay(l.timestamp), actor: l.actor_id }));
    const dauMau = Array.from({ length: 9 }, (_, i) => {
        const t = now - (8 - i) * DAY;
        const dayKey = isoDay(t);
        const monthStart = isoDay(t - 29 * DAY);
        return {
            label: label(t),
            dau: new Set(loginsWithDay.filter((l) => l.day === dayKey).map((l) => l.actor)).size,
            mau: new Set(loginsWithDay.filter((l) => l.day >= monthStart && l.day <= dayKey).map((l) => l.actor)).size,
        };
    });

    const countBetween = (sql, from, to) => db.prepare(sql).get(from, to).n;
    const sessions30 = countBetween("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'Login' AND status = 'Success' AND timestamp >= ? AND timestamp < ?", since30, new Date(now + DAY).toISOString());
    const sessionsPrev = countBetween("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'Login' AND status = 'Success' AND timestamp >= ? AND timestamp < ?", since60, since30);
    const api30 = apiRequestsBetween(isoDay(now - 29 * DAY), isoDay(now));
    const apiPrev = apiRequestsBetween(isoDay(now - 59 * DAY), isoDay(now - 30 * DAY));

    // Module usage from the audit trail.
    const byModule = (from, to) => Object.fromEntries(db.prepare(`SELECT module, COUNT(*) AS actions, COUNT(DISTINCT actor_id) AS admins
        FROM audit_logs WHERE timestamp >= ? AND timestamp < ? AND action NOT IN ('Login', 'Logout') GROUP BY module`).all(from, to).map((r) => [r.module, r]));
    const current = byModule(since30, new Date(now + DAY).toISOString());
    const previous = byModule(since60, since30);
    const activeAdmins = Math.max(1, db.prepare("SELECT COUNT(*) AS n FROM admin_users WHERE status = 'Active'").get().n);
    const moduleUsage = Object.values(current).sort((a, b) => b.actions - a.actions).map((m) => {
        const before = previous[m.module]?.actions ?? 0;
        return {
            module: m.module,
            users: m.admins,
            sessions: m.actions,
            usage: Math.min(100, Math.round((m.admins / activeAdmins) * 100)),
            trend: m.actions > before ? 'up' : m.actions < before ? 'down' : 'flat',
        };
    });

    const alertsTrend = Array.from({ length: 9 }, (_, i) => {
        const t = now - (8 - i) * DAY;
        const n = db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE status = 'Failed' AND substr(timestamp, 1, 10) = ?").get(isoDay(t)).n;
        return { label: label(t), value: n };
    });

    res.json({
        heatmap: { days: HEATMAP_DAYS, values: counts.map((row) => row.map((n) => n / peak)), counts },
        dauMau,
        sessions: { last30: sessions30, previous30: sessionsPrev, change: pctChange(sessions30, sessionsPrev) },
        apiRequests: { last30: api30, previous30: apiPrev, change: pctChange(api30, apiPrev) },
        moduleUsage,
        alertsTrend,
        storageBytes: fileSize(settings.databaseFile) + fileSize(`${settings.databaseFile}-wal`),
    });
});

export default router;
