import express from 'express';
import cors from 'cors';
import { settings } from './config.js';
import authRouter from './routes/auth.js';
import passwordResetRouter from './routes/passwordReset.js';
import usersRouter from './routes/users.js';
import rolesRouter from './routes/roles.js';
import settingsRouter from './routes/settings.js';
import claimsRouter from './routes/claims.js';
import changesRouter from './routes/changes.js';
import downloadsRouter from './routes/downloads.js';
import reportsRouter from './routes/reports.js';
import integrationsRouter from './routes/integrations.js';
import communicationRouter from './routes/communication.js';
import systemRouter from './routes/system.js';
import { mountResources } from './routes/resources.js';
import { countUsage } from './services/usage.js';

export const app = express();

// Behind nginx: trust X-Forwarded-* from the local proxy only.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(cors({ origin: settings.corsOrigins, credentials: true }));
// Profile images travel as data URLs (max 1 MB file).
app.use(express.json({ limit: '3mb' }));

const api = express.Router();
api.use(countUsage);
api.get('/health', (_req, res) => res.json({ status: 'ok', service: 'admin-service' }));

// Public
api.use('/auth', authRouter);
api.use('/password-reset', passwordResetRouter);

// Signed in (each router checks the token itself; claims/ingest also takes X-Service-Key)
api.use('/users', usersRouter);
api.use('/roles', rolesRouter);
api.use('/settings', settingsRouter);
api.use('/claims', claimsRouter);
api.use('/downloads', downloadsRouter);
api.use('/reports', reportsRouter);
api.use('/integrations', integrationsRouter);
api.use('/system', systemRouter);
api.use(changesRouter); // /changes, /audit-logs
api.use(communicationRouter); // GET /channels (+ sentToday), /comm-logs, send test, retry -- before the generic /channels resource
mountResources(api); // branches, document-templates, comm-rules, comm-templates, channels, fraud-rules, authority-matrix, approval-history, compliance-log, triggers

api.use((_req, res) => res.status(404).json({ detail: 'Not found.' }));
app.use('/api/v1', api);

app.get('/', (_req, res) => {
    res.json({ service: 'IBimaAssist Admin Service', status: 'running', api: '/api/v1', health: '/api/v1/health' });
});

// Errors -> JSON. HttpError carries its own status; anything else is a 500.
app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ detail: 'Request body is not valid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ detail: 'Request is too large.' });
    if (err.status && err.detail) return res.status(err.status).json({ detail: err.detail, ...err.extra });
    console.error(err);
    return res.status(500).json({ detail: 'Something went wrong on the server.' });
});
