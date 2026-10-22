import { settings } from '../config.js';

// Outgoing SMS / Email / WhatsApp. This service has no gateway of its own:
// with NOTIFY_WEBHOOK_URL set, each message is POSTed there as JSON
// { channel, to, subject, message, claimNo, reference } and the HTTP result
// decides Delivered / Failed. Without it nothing leaves the building and the
// message is logged as Pending -- the portal shows that honestly.

/** -> { status: 'Delivered' | 'Failed' | 'Pending', error? } */
export async function dispatch({ channel, to, subject, message, claimNo, reference }) {
    if (!settings.notifyWebhookUrl) return { status: 'Pending', error: 'No message gateway configured (NOTIFY_WEBHOOK_URL).' };
    try {
        const res = await fetch(settings.notifyWebhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(settings.notifyWebhookToken ? { Authorization: `Bearer ${settings.notifyWebhookToken}` } : {}),
            },
            body: JSON.stringify({ channel, to, subject, message, claimNo, reference }),
            signal: AbortSignal.timeout(8000),
        });
        return res.ok ? { status: 'Delivered' } : { status: 'Failed', error: `Gateway answered ${res.status}.` };
    } catch (err) {
        return { status: 'Failed', error: `Gateway not reachable: ${err.message}` };
    }
}

export const gatewayConfigured = () => !!settings.notifyWebhookUrl;
