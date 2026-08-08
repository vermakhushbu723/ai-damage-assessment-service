// Backs the "Start Training" button in Annotation Studio -- runs the same
// two scripts training/README.md tells you to run by hand
// (prepare_dataset.py, then train.py) as child processes, so nobody has to
// open a terminal. This is a thin process-runner, not a job queue: one
// training job at a time, in-memory status, no persistence across a
// server restart -- appropriate for a single-admin dev/test tool, not a
// production training service.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { z } from 'zod';
import { settings } from '../config.js';
import { VEHICLE_TYPES } from '../schemas/constants.js';

const router = Router();

const TRAINING_DIR = path.resolve(process.cwd(), settings.trainingDir);
const PYTHON_EXE = path.resolve(process.cwd(), settings.trainingPythonExecutable);
const RAW_POOL_ROOT = path.resolve(process.cwd(), settings.trainingRawPoolDir);
const RUNS_ROOT = path.join(TRAINING_DIR, 'runs', 'segment');
const MAX_LOG_LINES = 4000;

// Chart/image files Ultralytics writes into a run directory that are worth
// showing an admin -- allowlisted (also doubles as the anti-path-traversal
// check for /training/report-image below).
const REPORT_IMAGE_FILES = [
    'results.png', 'confusion_matrix.png', 'confusion_matrix_normalized.png',
    'BoxPR_curve.png', 'MaskPR_curve.png', 'labels.jpg', 'val_batch0_pred.jpg',
];

// results.csv columns -> a plain-language label + which are "higher is
// better" vs "lower is better" so the UI can show a ✓/⚠ without the admin
// needing to know YOLO metric names. (M) = mask (segmentation) metrics --
// the ones that actually matter for damage-region detection; (B) = box
// metrics, kept for reference.
const METRIC_LABELS = [
    { key: 'metrics/mAP50(M)', label: 'Detection accuracy (mAP50, mask)', good: 'high', format: 'percent' },
    { key: 'metrics/mAP50-95(M)', label: 'Detection accuracy, stricter (mAP50-95, mask)', good: 'high', format: 'percent' },
    { key: 'metrics/precision(M)', label: 'Precision (mask) — of flagged damage, % actually correct', good: 'high', format: 'percent' },
    { key: 'metrics/recall(M)', label: 'Recall (mask) — of real damage, % actually caught', good: 'high', format: 'percent' },
    { key: 'train/box_loss', label: 'Training loss (box)', good: 'low', format: 'number' },
    { key: 'train/seg_loss', label: 'Training loss (segmentation mask)', good: 'low', format: 'number' },
    { key: 'val/box_loss', label: 'Validation loss (box)', good: 'low', format: 'number' },
    { key: 'val/seg_loss', label: 'Validation loss (segmentation mask)', good: 'low', format: 'number' },
];

/**
 * Reads results.csv (one row per epoch, written live by Ultralytics) and
 * returns the last (most recent) epoch's numbers as a plain-language
 * report, plus how many epochs actually ran. Returns null if the file
 * isn't there yet (e.g. training failed before epoch 1 finished).
 */
function readTrainingReport(runDir) {
    const csvPath = path.join(runDir, 'results.csv');
    if (!fs.existsSync(csvPath)) return null;

    const lines = fs.readFileSync(csvPath, 'utf-8').trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const headers = lines[0].split(',').map((h) => h.trim());
    const lastRow = lines[lines.length - 1].split(',').map((v) => Number(v.trim()));
    const byHeader = Object.fromEntries(headers.map((h, i) => [h, lastRow[i]]));

    const metrics = METRIC_LABELS
        .filter((m) => byHeader[m.key] !== undefined)
        .map((m) => ({ label: m.label, value: byHeader[m.key], good: m.good, format: m.format }));

    const images = REPORT_IMAGE_FILES.filter((f) => fs.existsSync(path.join(runDir, f)));

    return {
        epochsRan: lines.length - 1,
        metrics,
        images,
    };
}

const startTrainingSchema = z.object({
    vehicle_type: z.enum(VEHICLE_TYPES),
    epochs: z.number().int().positive().max(1000).default(100),
    base: z.string().min(1).default('yolo11l-seg.pt'),
    device: z.string().min(1).default('cpu'), // 'cpu' or '0' (first GPU)
    // Found by crashing a lot: yolo11l-seg.pt (large) at the default
    // batch=16/imgsz=1280 reliably segfaults (exit 0xC0000005) on a 16GB
    // CPU-only machine -- it's a memory-exhaustion crash during the first
    // batch's mosaic augmentation + forward pass, not a code bug, and it
    // gives no Python traceback since the OOM happens inside OpenCV/torch
    // native code. batch=2 fixed it in testing. Default low on CPU;
    // GPUs have far more headroom so default higher there.
    batch: z.number().int().positive().max(256).optional(),
});

// Single global job -- see file header. `child` holds the currently
// running process (for cancel); everything else is what /status reports.
let job = {
    status: 'idle', // idle | preparing | training | completed | failed | cancelled
    vehicleType: null,
    epochs: null,
    batch: null,
    startedAt: null,
    finishedAt: null,
    log: [],
    error: null,
    resultCheckpoint: null,
    runName: null,
    report: null,
};
let child = null;

function resetJob(vehicleType, epochs, batch) {
    job = {
        status: 'preparing',
        vehicleType,
        epochs,
        batch,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        log: [],
        error: null,
        resultCheckpoint: null,
        runName: null,
        report: null,
    };
}

function appendLog(text) {
    for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        job.log.push(line);
    }
    if (job.log.length > MAX_LOG_LINES) job.log = job.log.slice(-MAX_LOG_LINES);
}

/** Runs one script to completion, resolving its exit code. Rejects only if the process itself couldn't be spawned. */
function runScript(scriptName, args) {
    return new Promise((resolve, reject) => {
        appendLog(`\n$ ${path.basename(PYTHON_EXE)} scripts/${scriptName} ${args.join(' ')}\n`);
        child = spawn(PYTHON_EXE, [`scripts/${scriptName}`, ...args], { cwd: TRAINING_DIR });
        child.stdout.on('data', (chunk) => appendLog(chunk.toString()));
        child.stderr.on('data', (chunk) => appendLog(chunk.toString()));
        child.on('error', (err) => reject(err)); // e.g. PYTHON_EXE not found
        child.on('close', (code) => { child = null; resolve(code); });
    });
}

// device === 'cpu' -> small batch (see the crash note on startTrainingSchema
// above); anything else is treated as a GPU index -> Ultralytics' own
// default-ish batch is fine.
function defaultBatchFor(device) {
    return device === 'cpu' ? 2 : 16;
}

async function runTrainingJob({ vehicleType, epochs, base, device, batch }) {
    try {
        const prepareCode = await runScript('prepare_dataset.py', [
            '--raw-pool', RAW_POOL_ROOT,
            '--vehicle-type', vehicleType,
            '--train', '0.8', '--val', '0.1', '--test', '0.1',
        ]);
        if (prepareCode !== 0) {
            job.status = job.status === 'cancelled' ? 'cancelled' : 'failed';
            job.error = `prepare_dataset.py exited with code ${prepareCode} -- see log.`;
            job.finishedAt = new Date().toISOString();
            return;
        }

        job.status = 'training';
        const runName = `${vehicleType}_webui_${Date.now()}`;
        job.runName = runName;
        const trainCode = await runScript('train.py', [
            '--vehicle-type', vehicleType,
            '--base', base,
            '--epochs', String(epochs),
            '--batch', String(batch),
            '--device', device,
            '--run-name', runName,
        ]);

        const runDir = path.join(RUNS_ROOT, runName);
        // Read whatever results.csv exists even on failure/cancel -- a run
        // that got through a few epochs before dying still has a partial,
        // still-useful report.
        job.report = readTrainingReport(runDir);

        if (trainCode !== 0) {
            job.status = job.status === 'cancelled' ? 'cancelled' : 'failed';
            job.error = `train.py exited with code ${trainCode} -- see log.`;
            // 3221225477 (0xC0000005, Windows access violation) with no
            // Python traceback above it is the signature of the CPU
            // memory-exhaustion crash documented on startTrainingSchema's
            // `batch` field -- happened repeatedly with yolo11l-seg.pt at
            // batch=16 on a 16GB machine; batch=2 fixed it in testing.
            if (trainCode === 3221225477 && device === 'cpu') {
                job.error += ' This looks like the known CPU memory crash (large checkpoint + batch too high for available ' +
                    `RAM) -- it crashed with batch=${batch}. Try again with a smaller batch (e.g. 1-2), a smaller base ` +
                    "checkpoint (yolo11n-seg.pt), or on a GPU. See training/README.md's CPU troubleshooting note.";
            }
        } else {
            job.status = 'completed';
            job.resultCheckpoint = path.join(runDir, 'weights', 'best.pt');
        }
    } catch (err) {
        job.status = 'failed';
        job.error = `Could not run training scripts: ${err.message}. Is Python set up at ` +
            `${PYTHON_EXE}? See training/README.md.`;
    } finally {
        job.finishedAt = new Date().toISOString();
    }
}

function jobOut() {
    return {
        status: job.status,
        vehicle_type: job.vehicleType,
        epochs: job.epochs,
        batch: job.batch,
        started_at: job.startedAt,
        finished_at: job.finishedAt,
        error: job.error,
        result_checkpoint: job.resultCheckpoint,
        log_tail: job.log.slice(-300),
        log_lines: job.log.length,
        run_name: job.runName,
        report: job.report && {
            epochs_ran: job.report.epochsRan,
            metrics: job.report.metrics,
            // Client hits these via GET /api/v1/training/report-image?run=...&file=...
            image_urls: job.report.images.map(
                (file) => `/api/v1/training/report-image?run=${encodeURIComponent(job.runName)}&file=${encodeURIComponent(file)}`
            ),
        },
    };
}

router.post('/api/v1/training/start', (req, res) => {
    if (job.status === 'preparing' || job.status === 'training') {
        return res.status(409).json({ detail: `A training job is already ${job.status} (${job.vehicleType}). Wait or cancel it first.` });
    }
    const parsed = startTrainingSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ detail: parsed.error.issues });
    }
    if (!fs.existsSync(PYTHON_EXE)) {
        return res.status(400).json({
            detail: `Training Python not found at ${PYTHON_EXE}. Run the setup in training/README.md ` +
                '("python -m venv .venv-training" at the service root + pip install -r training/requirements.txt), ' +
                'or set TRAINING_PYTHON in server/.env if it lives elsewhere.',
        });
    }

    const { vehicle_type: vehicleType, epochs, base, device } = parsed.data;
    const batch = parsed.data.batch ?? defaultBatchFor(device);
    resetJob(vehicleType, epochs, batch);
    runTrainingJob({ vehicleType, epochs, base, device, batch }); // fire-and-forget; poll /status

    return res.json({ started: true, job: jobOut() });
});

router.get('/api/v1/training/status', (_req, res) => res.json(jobOut()));

// GET /api/v1/training/report-image?run=<runName>&file=<one of REPORT_IMAGE_FILES>
// Serves a single chart/image from a completed run's directory. `file` is
// checked against the allowlist (not just any filename) specifically to
// rule out path traversal via this query param.
router.get('/api/v1/training/report-image', (req, res) => {
    const { run, file } = req.query;
    if (!run || !/^[a-zA-Z0-9_.-]+$/.test(run)) {
        return res.status(400).json({ detail: 'Invalid run name.' });
    }
    if (!REPORT_IMAGE_FILES.includes(file)) {
        return res.status(400).json({ detail: `file must be one of: ${REPORT_IMAGE_FILES.join(', ')}` });
    }
    const filePath = path.join(RUNS_ROOT, run, file);
    if (!filePath.startsWith(RUNS_ROOT) || !fs.existsSync(filePath)) {
        return res.status(404).json({ detail: 'Report image not found.' });
    }
    return res.sendFile(filePath);
});

router.post('/api/v1/training/cancel', (_req, res) => {
    if (!child) {
        return res.status(400).json({ detail: 'No training job is currently running.' });
    }
    job.status = 'cancelled';
    child.kill();
    return res.json({ cancelled: true });
});

export default router;
