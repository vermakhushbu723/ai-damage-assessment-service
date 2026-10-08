import { Router } from 'express';
import { asyncHandler, notFound, HttpError } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import { listRecords, findRecord, insertRecord, updateRecord } from '../models/recordModel.js';
import { nextSequentialId } from '../utils/ids.js';
import { sendViaGateway, GatewayError } from '../services/integrations.js';
import { GATEWAY_INTEGRATION_ID } from '../db/defaults.js';

// Communication Setup: channels with today's delivery count, the message
// log, "Send Test" and "Retry". Sending goes through the Communication
// Gateway integration -- nothing is marked delivered unless it answered 2xx.

const router = Router();

const isToday = (iso) => iso && iso.slice(0, 10) === new Date().toISOString().slice(0, 10);

function sentToday(channelName) {
    return listRecords('commLogs').filter((l) => l.channel === channelName && l.status === 'Delivered' && isToday(l.at)).length;
}

/** GET /api/v1/channels -- with `sentToday` counted from the log. */
router.get('/channels', authenticate, (_req, res) => {
    res.json(listRecords('channels', { order: 'asc' }).map((c) => ({ ...c, sentToday: sentToday(c.name) })));
});

/** GET /api/v1/comm-logs -- newest first. */
router.get('/comm-logs', authenticate, (_req, res) => {
    res.json(listRecords('commLogs').sort((a, b) => String(b.at).localeCompare(String(a.at))));
});

async function deliver(payload) {
    try {
        await sendViaGateway(GATEWAY_INTEGRATION_ID, payload);
    } catch (err) {
        if (err instanceof GatewayError) throw new HttpError(502, err.message);
        throw err;
    }
}

/** POST /api/v1/channels/:id/test -- sends a test message; logged like any other. */
router.post('/channels/:id/test', authenticate, asyncHandler(async (req, res) => {
    const channel = findRecord('channels', req.params.id);
    if (!channel) throw notFound('Channel');
    if (!channel.enabled) throw new HttpError(409, `${channel.name} channel is switched off.`);
    const message = `Test message from IBima Assist (${channel.name}).`;
    const base = { claim: '—', communication: 'Test message', recipient: req.admin.name, to: req.admin.email, channel: channel.name, message };
    let status = 'Delivered';
    let error = null;
    try {
        await deliver({ channel: channel.name, to: req.admin.email, recipient: req.admin.name, message, claim: null, reference: 'test' });
    } catch (err) {
        status = 'Failed';
        error = err;
    }
    insertRecord('commLogs', { ...base, status, at: new Date().toISOString(), id: nextSequentialId('records', 'LOG', 1000, 'commLogs') });
    if (error) throw error;
    res.json({ ...channel, sentToday: sentToday(channel.name) });
}));

/** POST /api/v1/comm-logs/:id/retry -- re-sends a failed message. */
router.post('/comm-logs/:id/retry', authenticate, asyncHandler(async (req, res) => {
    const log = findRecord('commLogs', req.params.id);
    if (!log) throw notFound('Message');
    if (log.status === 'Delivered') throw new HttpError(409, 'This message was already delivered.');
    const channel = listRecords('channels').find((c) => c.name === log.channel);
    if (!channel?.enabled) throw new HttpError(409, `${log.channel} channel is switched off — enable it under Channels first.`);
    await deliver({ channel: log.channel, to: log.to ?? null, recipient: log.recipient, message: log.message ?? log.communication, claim: log.claim, reference: log.id });
    res.json(updateRecord('commLogs', log.id, { status: 'Delivered', at: new Date().toISOString(), retriedBy: req.admin.name }));
}));

export default router;
