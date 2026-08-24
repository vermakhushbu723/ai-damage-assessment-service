import express from 'express';
import cors from 'cors';
import { settings } from './config.js';
import claimsRouter from './routes/claims.js';

export const app = express();

app.use(cors({ origin: settings.corsOrigins, credentials: true }));
app.use(express.json({ limit: '1mb' }));

app.use(claimsRouter);

app.get('/', (_req, res) => {
    res.json({
        service: 'IBimaAssist Claims Service',
        status: 'running',
        message: 'Claims backend chal raha hai ✅',
        health_check: '/health',
    });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ detail: err.message || 'Internal server error' });
});
