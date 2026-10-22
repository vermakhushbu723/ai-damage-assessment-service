import 'dotenv/config';

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
    databaseFile: process.env.DATABASE_FILE || './claims.db',
    corsOrigins: process.env.CORS_ORIGINS === '*'
        ? true
        : toList(process.env.CORS_ORIGINS || 'http://localhost:5173,https://localhost:5173,http://localhost:4173,https://localhost:4173'),
};
