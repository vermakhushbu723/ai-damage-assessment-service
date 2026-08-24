import express from 'express';
import cors from 'cors';
import { settings } from './config.js';
import authRouter from './routes/auth.js';

export const app = express();

app.use(cors({ origin: settings.corsOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.use(authRouter);

// GET / -- plain "yes, this is up" message, same convention as
// ../../server/src/app.js -- lets whoever hits the bare URL (browser, or a
// deploy check) confirm the service is actually running.
app.get('/', (_req, res) => {
    res.json({
        service: 'IBimaAssist Auth Service',
        status: 'running',
        message: 'Auth backend chal raha hai ✅',
        health_check: '/health',
        portals: ['claim_workshop', 'claim_surveyor', 'preinspection_agent', 'preinspection_surveyor'],
    });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Last-resort error handler so a thrown error becomes a clean 500 JSON
// response instead of an unhandled-exception stack trace to the client.
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ detail: err.message || 'Internal server error' });
});
