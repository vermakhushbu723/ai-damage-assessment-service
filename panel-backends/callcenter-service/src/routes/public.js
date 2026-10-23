import { Router } from 'express';
import { db, nowIso, parseJson } from '../db/database.js';
import { settings } from '../config.js';
import { setClaimFields, audit } from '../models/claimModel.js';

// Public (no sign-in) routes. GET /s/:token is the survey link customers
// receive: it records that the link was opened (dashboard "Survey Link Sent
// Summary": Successfully Accessed / Access Rate) and forwards to the survey
// page (SURVEY_LINK_BASE?token=...).

const router = Router();

router.get('/s/:token', (req, res) => {
    const token = String(req.params.token ?? '');
    const target = `${settings.surveyLinkBase}?token=${encodeURIComponent(token)}`;
    if (!/^[A-Za-z0-9_-]{10,60}$/.test(token)) return res.redirect(302, target);
    const row = db.prepare("SELECT id, link FROM claims WHERE json_extract(link, '$.token') = ?").get(token);
    if (row) {
        const link = parseJson(row.link, {});
        const first = !link.accessedAt;
        setClaimFields(row.id, { link: JSON.stringify({ ...link, accessedAt: link.accessedAt ?? nowIso(), lastAccessedAt: nowIso(), accessCount: (link.accessCount ?? 0) + 1 }) });
        if (first) audit(row.id, 'Survey link opened', 'Customer opened the survey link', { name: 'Customer' });
    }
    return res.redirect(302, target);
});

export default router;
