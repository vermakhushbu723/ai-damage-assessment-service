import { app } from './app.js';
import { settings } from './config.js';
import { seedDemoUsers } from './db/seed.js';

seedDemoUsers();

app.listen(settings.port, () => {
    console.log(`IBimaAssist Auth Service listening on http://localhost:${settings.port}`);
});
