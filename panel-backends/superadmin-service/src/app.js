import express from 'express';
import cors from 'cors';
import { settings } from './config.js';
import authRouter from './routes/auth.js';
import organizationsRouter from './routes/organizations.js';
import plansRouter from './routes/plans.js';
import adminUsersRouter from './routes/adminUsers.js';
import usersRouter from './routes/users.js';
import rolesRouter from './routes/roles.js';
import passwordResetRouter from './routes/passwordReset.js';
import auditLogsRouter from './routes/auditLogs.js';
import serviceModelsRouter from './routes/serviceModels.js';
import workflowsRouter from './routes/workflows.js';
import claimsRouter from './routes/claims.js';
import downloadsRouter from './routes/downloads.js';
import reportsRouter from './routes/reports.js';
import integrationsRouter from './routes/integrations.js';
import systemRouter from './routes/system.js';
import { countApiRequest } from './models/systemModel.js';

export const app = express();

// Behind nginx: trust X-Forwarded-* from the local proxy only.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(cors({ origin: settings.corsOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const api = express.Router();
// "API Usage" on the SaaS Usage Report = requests per day.
api.use((req, _res, next) => {
    if (req.path !== '/health') {
        try { countApiRequest(); } catch { /* never fail a request over the counter */ }
    }
    next();
});
api.use('/auth', authRouter);
api.use('/organizations', organizationsRouter);
api.use('/plans', plansRouter);
api.use('/admin-users', adminUsersRouter);
api.use('/users', usersRouter);
api.use('/roles', rolesRouter);
api.use('/password-reset', passwordResetRouter);
api.use('/audit-logs', auditLogsRouter);
api.use('/service-models', serviceModelsRouter);
api.use('/workflows', workflowsRouter);
api.use('/claims', claimsRouter);
api.use('/downloads', downloadsRouter);
api.use('/reports', reportsRouter);
api.use('/integrations', integrationsRouter);
api.use('/system', systemRouter);
api.get('/health', (_req, res) => res.json({ status: 'ok', service: 'superadmin-service' }));
api.use((_req, res) => res.status(404).json({ detail: 'Not found.' }));

app.use('/api/v1', api);

app.get('/', (_req, res) => {
    res.json({ service: 'IBimaAssist Super Admin Service', status: 'running', api: '/api/v1', health: '/api/v1/health' });
});

// Errors -> JSON. HttpError carries its own status; anything else is a 500.
app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ detail: 'Request body is not valid JSON.' });
    if (err.status && err.detail) return res.status(err.status).json({ detail: err.detail, ...err.extra });
    console.error(err);
    return res.status(500).json({ detail: 'Something went wrong on the server.' });
});
