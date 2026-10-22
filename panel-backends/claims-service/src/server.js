import { app } from './app.js';
import { settings } from './config.js';
import { seedSampleClaims } from './db/seed.js';

seedSampleClaims();

app.listen(settings.port, () => {
    console.log(`IBimaAssist Claims Service listening on http://localhost:${settings.port}`);
});
