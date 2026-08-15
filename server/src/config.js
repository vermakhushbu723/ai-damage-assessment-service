import 'dotenv/config';

function toList(csv) {
    return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

export const settings = {
    port: Number(process.env.PORT || 8000),
    yoloServiceUrl: process.env.YOLO_SERVICE_URL || 'http://localhost:8001',
    ollamaHost: process.env.OLLAMA_HOST || 'http://localhost:11434',
    // Client spec names llama3.1:8b; defaulting to the lighter llama3.2:3b
    // here instead -- report narration is zero-shot prompted (no
    // fine-tuning yet, see docs/ARCHITECTURE.md Section 5.2/9), and 3B is
    // far friendlier on a CPU-only/offline machine. Override back to
    // llama3.1:8b if you want the spec-exact model and have the resources.
    ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2:3b',
    ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_SECONDS || 60) * 1000,
    databaseFile: process.env.DATABASE_FILE || './ai_damage_assessment.db',
    uploadDir: process.env.UPLOAD_DIR || './uploads',
    // Where Annotation Studio saves uploaded photos + YOLO labels -- the
    // exact `raw_pool/<vehicle_type>/{images,labels}/` layout
    // training/scripts/prepare_dataset.py expects (see its docstring).
    // Default lives one level up from server/, next to training/data/.
    trainingRawPoolDir: process.env.TRAINING_RAW_POOL_DIR || '../training/raw_pool',
    // Where training/ (scripts + data + runs/) lives, one level up from
    // server/. Passed as `cwd` when spawning prepare_dataset.py/train.py.
    trainingDir: process.env.TRAINING_DIR || '../training',
    // Python executable used to run the *training* scripts (prepare_dataset.py,
    // train.py) -- separate from yolo-service's own Python, since training
    // needs the heavier `ultralytics` + `torch` install (see
    // training/requirements.txt). Defaults to the venv created per
    // training/README.md ("python -m venv .venv-training" at the service
    // root); override if you set it up elsewhere or use a system Python
    // that already has training/requirements.txt installed.
    trainingPythonExecutable: process.env.TRAINING_PYTHON || (
        process.platform === 'win32' ? '../.venv-training/Scripts/python.exe' : '../.venv-training/bin/python'
    ),
    // The web app's Vite dev server runs with `https: true` (self-signed
    // cert) -- both schemes are listed since the browser's actual origin
    // depends on that config. Set CORS_ORIGINS=* to allow ANY origin
    // (reflects whatever Origin the browser sent, since a literal `*` isn't
    // valid alongside `credentials: true`) -- useful while Vercel keeps
    // handing out a new preview URL per deploy, at the cost of no longer
    // restricting who can call this API from a browser. Lock this back down
    // to a real allowlist before this handles anything sensitive.
    corsOrigins: process.env.CORS_ORIGINS === '*'
        ? true
        : toList(process.env.CORS_ORIGINS || 'http://localhost:5173,https://localhost:5173,http://localhost:4173,https://localhost:4173'),
    retrainVolumeThreshold: Number(process.env.RETRAIN_VOLUME_THRESHOLD || 5000),
};
