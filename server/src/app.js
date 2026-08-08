import express from 'express';
import cors from 'cors';
import { settings } from './config.js';

import detectRouter from './routes/detect.js';
import assessRouter from './routes/assess.js';
import reportRouter from './routes/report.js';
import correctionsRouter from './routes/corrections.js';
import partsRatesRouter from './routes/partsRates.js';
import annotationsRouter from './routes/annotations.js';
import trainingRouter from './routes/training.js';

export const app = express();

app.use(cors({ origin: settings.corsOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));

app.use(detectRouter);
app.use(assessRouter);
app.use(reportRouter);
app.use(correctionsRouter);
app.use(partsRatesRouter);
app.use(annotationsRouter);
app.use(trainingRouter);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Last-resort error handler so a thrown error becomes a clean 500 JSON
// response instead of an unhandled-exception stack trace to the client.
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ detail: err.message || 'Internal server error' });
});
