import { Router } from 'express';
import { statSync } from 'node:fs';
import { settings } from '../config.js';
import { authenticate } from '../middleware/authenticate.js';
import { db } from '../db/database.js';
import { requestsBetween, moduleUsageBetween } from '../models/usageModel.js';
import { listRecords } from '../models/recordModel.js';
import { USAGE_MODULES } from '../services/usage.js';

const router = Router();
router.use(authenticate);

const DAY = 86400_000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const label = (t) => { const d = new Date(t); return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`; };
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
 * GET /api/v1/reports/usage -- everything measured, nothing sample:
 *  - cards: organizations, active users, sessions, API requests, storage, feature adoption (+ change vs previous 30 days)
 *  - dauMau: last 9 days, distinct admins signed in that day / in the 30 days up to it
 *  - modules: requests per portal module over the last 30 days (users, sessions = active days, usage %, trend)
 *  - heatmap: sign-ins over the last 90 days, Mon-Sat x 12 two-hour slots, intensity 0-4
 *  - users: created-in-period counts for the User Report trend chips
 */
router.get('/usage', (_req, res) => {
    const now = Date.now();
    const iso = (t) => new Date(t).toISOString();
    const today = isoDay(now);
    const d30 = isoDay(now - 29 * DAY);
    const d60 = isoDay(now - 59 * DAY);
    const d31 = isoDay(now - 30 * DAY);

    const logins = db.prepare("SELECT at, actor_id FROM audit_events WHERE reference = 'Login' AND status = 'Success' AND at >= ?").all(iso(now - 90 * DAY));
    const loginsIn = (from, to) => logins.filter((l) => l.at.slice(0, 10) >= from && l.at.slice(0, 10) <= to).length;

    // Heat map (server local time).
    const counts = HEATMAP_DAYS.map(() => Array(12).fill(0));
    for (const l of logins) {
        const d = new Date(l.at);
        const weekday = (d.getDay() + 6) % 7;
        if (weekday <= 5) counts[weekday][Math.floor(d.getHours() / 2)]++;
    }
    const peak = Math.max(...counts.flat());
    const heatmap = HEATMAP_DAYS.map((dayName, i) => ({ day: dayName, slots: counts[i].map((n) => (peak ? Math.ceil((n / peak) * 4) : 0)), counts: counts[i] }));

    const dauMau = Array.from({ length: 9 }, (_, i) => {
        const t = now - (8 - i) * DAY;
        const key = isoDay(t);
        const start = isoDay(t - 29 * DAY);
        return {
            day: label(t),
            dau: new Set(logins.filter((l) => l.at.slice(0, 10) === key).map((l) => l.actor_id)).size,
            mau: new Set(logins.filter((l) => l.at.slice(0, 10) >= start && l.at.slice(0, 10) <= key).map((l) => l.actor_id)).size,
        };
    });

    const current = Object.fromEntries(moduleUsageBetween(d30, today).map((m) => [m.module, m]));
    const previous = Object.fromEntries(moduleUsageBetween(d60, d31).map((m) => [m.module, m]));
    const totalRequests = Object.values(current).reduce((n, m) => n + m.requests, 0);
    const modules = Object.values(current).sort((a, b) => b.requests - a.requests).map((m) => {
        const before = previous[m.module]?.requests ?? 0;
        return {
            id: m.module,
            module: m.module,
            requests: m.requests,
            users: m.admins,
            sessions: m.days,
            usage: totalRequests ? Math.round((m.requests / totalRequests) * 100) : 0,
            trend: m.requests > before ? 'up' : m.requests < before ? 'down' : 'flat',
        };
    });

    const users = db.prepare('SELECT status, organization, created_at FROM users').all();
    const createdIn = (from, to) => users.filter((u) => u.created_at.slice(0, 10) >= from && u.created_at.slice(0, 10) <= to).length;
    const activeUsers = users.filter((u) => u.status === 'Active');
    const orgs = new Set([
        ...activeUsers.map((u) => u.organization).filter(Boolean),
        ...listRecords('branches').filter((b) => b.status === 'Active').map((b) => b.organization),
    ]);
    const used = (set) => USAGE_MODULES.filter((m) => set[m]).length;
    const adoption = USAGE_MODULES.length ? Math.round((used(current) / USAGE_MODULES.length) * 1000) / 10 : 0;
    const adoptionBefore = USAGE_MODULES.length ? Math.round((used(previous) / USAGE_MODULES.length) * 1000) / 10 : 0;
    const sessions = loginsIn(d30, today);
    const sessionsBefore = loginsIn(d60, d31);
    const api = requestsBetween(d30, today);
    const apiBefore = requestsBetween(d60, d31);
    const storageBytes = fileSize(settings.databaseFile) + fileSize(`${settings.databaseFile}-wal`);
    const createdNow = createdIn(d30, today);
    const createdBefore = createdIn(d60, d31);

    res.json({
        cards: {
            orgs: { value: orgs.size, change: null },
            users: { value: activeUsers.length, change: pctChange(createdNow, createdBefore) },
            sessions: { value: sessions, change: pctChange(sessions, sessionsBefore) },
            api: { value: api, change: pctChange(api, apiBefore) },
            storage: { value: storageBytes, change: null },
            adoption: { value: adoption, change: Math.round((adoption - adoptionBefore) * 10) / 10 },
        },
        dauMau,
        modules,
        heatmap,
        users: {
            total: users.length,
            totalBefore: users.length - createdNow,
            created30: createdNow,
            createdPrevious30: createdBefore,
            change: pctChange(createdNow, createdBefore),
        },
    });
});

export default router;
