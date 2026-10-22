import { app } from './app.js';
import { settings } from './config.js';
import { flush } from './services/sync.js';
import { sendDueReminders } from './services/reminders.js';

if (!settings.adminServiceKey) {
    console.warn('[callcenter-service] WARNING: ADMIN_SERVICE_KEY is empty -- nobody can sign in and claims are not pushed to the Admin portal.');
}

// Push queued claims / logs to the Admin portal and send due reminders every minute.
const tick = async () => {
    await flush().catch(() => {});
    await sendDueReminders().catch((err) => console.error('[reminders]', err.message));
};
setInterval(tick, 60_000).unref();
setTimeout(tick, 3000).unref();

app.listen(settings.port, '127.0.0.1', () => {
    console.log(`IBimaAssist Call Center Service listening on http://127.0.0.1:${settings.port} (API: /api/v1)`);
});
