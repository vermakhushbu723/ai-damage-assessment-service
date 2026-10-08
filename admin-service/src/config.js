import 'dotenv/config';

const toList = (csv) => csv.split(',').map((s) => s.trim()).filter(Boolean);

const DEV_SECRET = 'dev-only-change-me-before-deploying';
const jwtSecret = process.env.JWT_SECRET || DEV_SECRET;
if (jwtSecret === DEV_SECRET) {
    console.warn('[admin-service] WARNING: JWT_SECRET is the default dev value. Set a real secret in .env before deploying.');
}

export const settings = {
    port: Number(process.env.PORT || 8040),
    jwtSecret,
    jwtExpiresInSeconds: Number(process.env.JWT_EXPIRES_IN_SECONDS || 28800),
    databaseFile: process.env.DATABASE_FILE || './admin.db',
    corsOrigins: process.env.CORS_ORIGINS === '*'
        ? true
        : toList(process.env.CORS_ORIGINS || 'http://localhost:5200,http://127.0.0.1:5200,http://localhost:4200'),
    // The insurer this portal belongs to ("Internal" users and branches default to it).
    organizationName: process.env.ORGANIZATION_NAME || 'ABG Insurance',
    resetLinkBase: process.env.RESET_LINK_BASE || 'http://localhost:5200/reset-password',
    resetLinkTtlHours: Number(process.env.RESET_LINK_TTL_HOURS || 24),
    // Shared secret claim systems send as X-Service-Key to POST /api/v1/claims/ingest. Empty = disabled.
    claimsIngestKey: process.env.CLAIMS_INGEST_KEY || '',
    // System Settings > System Update.
    productName: process.env.PRODUCT_NAME || 'IBima Assist Enterprise',
    environmentName: process.env.ENVIRONMENT_NAME || 'Production Environment',
    appVersion: process.env.APP_VERSION || '2.4.1',
    latestVersion: process.env.LATEST_VERSION || process.env.APP_VERSION || '2.4.1',
    latestReleaseDate: process.env.LATEST_RELEASE_DATE || null,
    maxFailedLogins: 5,
    lockMinutes: 15,
    bootstrapAdmin: {
        name: process.env.BOOTSTRAP_ADMIN_NAME || 'Admin',
        email: process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@ibima.com',
        mobile: process.env.BOOTSTRAP_ADMIN_MOBILE || '',
        password: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
    },
};
