import { app } from './app.js';
import { settings } from './config.js';
import { seedPartsRates } from './db/seed.js';

seedPartsRates();

app.listen(settings.port, () => {
    console.log(`AI Damage Assessment (Node) service listening on http://localhost:${settings.port}`);
    console.log(`YOLO inference service expected at ${settings.yoloServiceUrl} (../yolo-service)`);
});
