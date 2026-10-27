import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// The service folder (one level up from src/). .env and every relative path
// below resolve from here, so the service behaves the same whichever
// directory it is started from (pm2, npm start, node src/server.js, ...).
const SERVICE_ROOT = fileURLToPath(new URL('..', import.meta.url));
dotenv.config({ path: resolve(SERVICE_ROOT, '.env') });
const fromRoot = (path) => resolve(SERVICE_ROOT, path);

function toList(csv) {
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

const jwtSecret = process.env.JWT_SECRET || 'dev-only-change-me-before-deploying';
if (jwtSecret === 'dev-only-change-me-before-deploying') {
    console.warn('[claims-service] WARNING: JWT_SECRET is using the default dev value. Set a real secret in .env before deploying -- and make sure it matches ../auth-service/.env exactly.');
}

export const settings = {
    port: Number(process.env.PORT || 8020),
    jwtSecret,
    databaseFile: fromRoot(process.env.DATABASE_FILE || './claimsServiceProvider.db'),
    corsOrigins: process.env.CORS_ORIGINS === '*'
        ? true
        : toList(process.env.CORS_ORIGINS || 'http://localhost:5173,https://localhost:5173,http://localhost:4173,https://localhost:4173'),
};
