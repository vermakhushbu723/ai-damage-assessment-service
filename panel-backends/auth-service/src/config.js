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
    // Loud, not fatal -- local dev should keep working out of the box, but
    // this must never reach production unchanged (see .env.example).
    console.warn('[auth-service] WARNING: JWT_SECRET is using the default dev value. Set a real secret in .env before deploying.');
}

export const settings = {
    port: Number(process.env.PORT || 8010),
    jwtSecret,
    jwtExpiresInSeconds: Number(process.env.JWT_EXPIRES_IN_SECONDS || 43200), // 12h
    databaseFile: fromRoot(process.env.DATABASE_FILE || './authServiceProvider.db'),
    // Same "CORS_ORIGINS=*" escape hatch as ../../ai-training-backend/server/src/config.js -- a
    // literal '*' isn't valid alongside `credentials: true`, so `true`
    // makes the cors package reflect whatever Origin the browser sent.
    corsOrigins: process.env.CORS_ORIGINS === '*'
        ? true
        : toList(process.env.CORS_ORIGINS || 'http://localhost:5173,https://localhost:5173,http://localhost:4173,https://localhost:4173'),
};
