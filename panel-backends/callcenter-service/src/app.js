import express from 'express';
import cors from 'cors';
import { settings } from './config.js';
import authRouter from './routes/auth.js';
import claimsRouter from './routes/claims.js';
import assignmentRouter from './routes/assignment.js';
import documentsRouter, { filesRouter } from './routes/documents.js';
import ilaRouter from './routes/ila.js';
import settlementRouter from './routes/settlement.js';
import communicationRouter from './routes/communication.js';
import { pendingCount } from './services/sync.js';
import { aiConfigured } from './services/aiClient.js';
import { gatewayConfigured } from './services/notifier.js';

export const app = express();

// Behind nginx: trust X-Forwarded-* from the local proxy only.
app.set('trust proxy', 'loopback');
app.disable('x-powered-by');
app.use(cors({ origin: settings.corsOrigins, credentials: true }));
app.use(express.json({ limit: '200kb' }));

const api = express.Router();
api.get('/health', (_req, res) => res.json({
    status: 'ok',
    service: 'callcenter-service',
    adminServiceConfigured: !!settings.adminServiceKey,
    pendingAdminSync: pendingCount(),
    aiConnected: aiConfigured(),
    messageGateway: gatewayConfigured(),
}));

// Public
api.use('/auth', authRouter);
api.use(filesRouter); // /files/:docId (signed links)

// Signed in (each router checks the token + role permissions itself)
api.use(claimsRouter); // /dashboard, /claims, intimation, survey link, remarks, audit, details
api.use(assignmentRouter); // /handlers, /surveyors, /claims/:id/handler, /claims/:id/surveyors
api.use(documentsRouter); // /claims/:id/documents
api.use(ilaRouter); // /claims/:id/ai-ila
api.use(settlementRouter); // /claims/:id/liability, /payment, /paybill
api.use(communicationRouter); // /claims/:id/letters, /communications

api.use((_req, res) => res.status(404).json({ detail: 'Not found.' }));
app.use('/api/v1', api);

app.get('/', (_req, res) => {
    res.json({ service: 'IBimaAssist Call Center Service', status: 'running', api: '/api/v1', health: '/api/v1/health' });
});

// Errors -> JSON. HttpError carries its own status; anything else is a 500.
app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ detail: 'Request body is not valid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ detail: `File is too large (max ${settings.maxUploadMb} MB).` });
    if (err.status && err.detail) return res.status(err.status).json({ detail: err.detail, ...err.extra });
    console.error(err);
    return res.status(500).json({ detail: 'Something went wrong on the server.' });
});
