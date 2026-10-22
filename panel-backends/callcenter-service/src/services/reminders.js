import { db, nowIso, parseJson } from '../db/database.js';
import { normalizePhone } from '../utils/http.js';
import { setClaimFields, audit } from '../models/claimModel.js';
import { insertCommunication } from '../models/communicationModel.js';
import { dispatch } from './notifier.js';

// Intimation "Auto Reminder": 2 hours after the survey link went out, if
// nothing came back on the claim, the link is sent once more.

const REMINDER_AFTER_MS = 2 * 3600_000;

export async function sendDueReminders() {
    const rows = db.prepare("SELECT * FROM claims WHERE status <> 'Closed' AND link LIKE '%\"autoReminder\":true%'").all();
    let sent = 0;
    for (const row of rows) {
        const link = parseJson(row.link, {});
        if (!link.autoReminder || !link.sentAt || link.reminderSentAt || !link.url) continue;
        if (Date.now() - new Date(link.sentAt).getTime() < REMINDER_AFTER_MS) continue;
        const answered = db.prepare("SELECT 1 FROM communications WHERE claim_id = ? AND direction = 'received' AND at > ?").get(row.id, link.sentAt);
        if (answered) continue;
        const via = link.sendVia?.includes('All') ? ['SMS', 'Whats App', 'Email'] : (link.sendVia ?? []);
        const channel = via[0];
        if (!channel) continue;
        const to = channel === 'Email' ? link.email : normalizePhone(link.mobile);
        if (!to) continue;
        const outcome = await dispatch({
            channel, to, subject: `Reminder: survey link for claim ${row.claim_no}`,
            message: `Reminder: please complete the vehicle survey for claim ${row.claim_no}: ${link.url}`, claimNo: row.claim_no, reference: link.token,
        });
        const system = { name: 'System' };
        setClaimFields(row.id, { link: JSON.stringify({ ...link, reminderSentAt: nowIso() }) });
        insertCommunication(row.id, {
            direction: 'sent', type: 'Reminder Sent', tag: 'Survey Link Reminder', reference: 'Auto reminder (no response in 2 hours)',
            description: 'Survey link sent again.', subDescription: outcome.error ?? link.url, person: 'Ibima Assist', personMeta: '(Auto)',
            channel: channel === 'Whats App' ? 'WhatsApp' : channel, recipient: to, status: outcome.status, awaitingResponse: true,
        });
        audit(row.id, 'Auto reminder sent', `${channel}: ${outcome.status}`, system);
        sent += 1;
    }
    return sent;
}
