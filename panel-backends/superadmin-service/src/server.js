import { app } from './app.js';
import { settings } from './config.js';
import { bootstrap, housekeeping } from './db/bootstrap.js';

bootstrap();
housekeeping();
setInterval(housekeeping, 6 * 3600_000).unref();

app.listen(settings.port, '127.0.0.1', () => {
    console.log(`IBimaAssist Super Admin Service listening on http://127.0.0.1:${settings.port} (API: /api/v1)`);
});
