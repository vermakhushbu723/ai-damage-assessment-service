import 'dotenv/config';

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
    databaseFile: process.env.DATABASE_FILE || './auth.db',
    // Same "CORS_ORIGINS=*" escape hatch as ../server/src/config.js -- a
    // literal '*' isn't valid alongside `credentials: true`, so `true`
    // makes the cors package reflect whatever Origin the browser sent.
    corsOrigins: process.env.CORS_ORIGINS === '*'
        ? true
        : toList(process.env.CORS_ORIGINS || 'http://localhost:5173,https://localhost:5173,http://localhost:4173,https://localhost:4173'),
};
