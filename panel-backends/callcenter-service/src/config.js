import 'dotenv/config';

const toList = (csv) => csv.split(',').map((s) => s.trim()).filter(Boolean);

const DEV_SECRET = 'dev-only-change-me-before-deploying';
const jwtSecret = process.env.JWT_SECRET || DEV_SECRET;
if (jwtSecret === DEV_SECRET) {
    console.warn('[callcenter-service] WARNING: JWT_SECRET is the default dev value. Set a real secret in .env before deploying.');
}

export const settings = {
    port: Number(process.env.PORT || 8050),
    jwtSecret,
    jwtExpiresInSeconds: Number(process.env.JWT_EXPIRES_IN_SECONDS || 28800),
    databaseFile: process.env.DATABASE_FILE || './callcenter.db',
    corsOrigins: process.env.CORS_ORIGINS === '*'
        ? true
        : toList(process.env.CORS_ORIGINS || 'http://localhost:5190,http://127.0.0.1:5190,http://localhost:4190'),

    // admin-service: users sign in with their Admin > Create Users account,
    // and every claim is pushed to the Admin portal through /claims/ingest.
    adminServiceUrl: (process.env.ADMIN_SERVICE_URL || 'http://127.0.0.1:8040').replace(/\/$/, ''),
    // Must equal CLAIMS_INGEST_KEY in admin-service/.env.
    adminServiceKey: process.env.ADMIN_SERVICE_KEY || '',
    // How long a signed-in user's admin record (status, role, permissions) is reused before re-checking.
    userCacheSeconds: Number(process.env.USER_CACHE_SECONDS || 30),

    // Documents DMS uploads (one folder per claim).
    uploadsDir: process.env.UPLOADS_DIR || './uploads',
    maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 10),
    fileLinkTtlSeconds: Number(process.env.FILE_LINK_TTL_SECONDS || 3600),

    // Survey link sent from the Intimation screen (?token= is appended).
    surveyLinkBase: process.env.SURVEY_LINK_BASE || 'https://survey.ibimaassist.online/s',
    // SMS / Email / WhatsApp go out through this webhook (POST JSON). Empty =
    // nothing is delivered: messages are logged with status Pending.
    notifyWebhookUrl: process.env.NOTIFY_WEBHOOK_URL || '',
    notifyWebhookToken: process.env.NOTIFY_WEBHOOK_TOKEN || '',

    // AI ILA backend (ai-training-backend/server, /api/v1/detect + /assess + /corrections). Empty = AI not connected.
    aiServiceUrl: (process.env.AI_SERVICE_URL || '').replace(/\/$/, ''),

    // Claim TAT shown in the claim header (SLA Risk after this many hours open).
    slaHours: Number(process.env.SLA_HOURS || 48),
};
