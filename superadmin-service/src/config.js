import 'dotenv/config';

const toList = (csv) => csv.split(',').map((s) => s.trim()).filter(Boolean);

const DEV_SECRET = 'dev-only-change-me-before-deploying';
const jwtSecret = process.env.JWT_SECRET || DEV_SECRET;
if (jwtSecret === DEV_SECRET) {
    console.warn('[superadmin-service] WARNING: JWT_SECRET is the default dev value. Set a real secret in .env before deploying.');
}

export const settings = {
    port: Number(process.env.PORT || 8030),
    jwtSecret,
    jwtExpiresInSeconds: Number(process.env.JWT_EXPIRES_IN_SECONDS || 28800),
    databaseFile: process.env.DATABASE_FILE || './superadmin.db',
    corsOrigins: process.env.CORS_ORIGINS === '*'
        ? true
        : toList(process.env.CORS_ORIGINS || 'http://localhost:5180,http://127.0.0.1:5180,http://localhost:4180'),
    resetLinkBase: process.env.RESET_LINK_BASE || 'http://localhost:5180/reset-password',
    resetLinkTtlHours: Number(process.env.RESET_LINK_TTL_HOURS || 24),
    // Failed-login lockout.
    maxFailedLogins: 5,
    lockMinutes: 15,
    bootstrapAdmins: [
        { scope: 'all', name: 'Super Admin', email: process.env.BOOTSTRAP_MASTER_EMAIL || 'superadmin@ibima.com', password: process.env.BOOTSTRAP_MASTER_PASSWORD || '' },
        { scope: 'saas', name: 'SaaS Super Admin', email: process.env.BOOTSTRAP_SAAS_EMAIL || 'saas.admin@ibima.com', password: process.env.BOOTSTRAP_SAAS_PASSWORD || '' },
        { scope: 'serviceProvider', name: 'Service Provider Super Admin', email: process.env.BOOTSTRAP_SP_EMAIL || 'sp.admin@ibima.com', password: process.env.BOOTSTRAP_SP_PASSWORD || '' },
    ],
};
