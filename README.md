# AI Damage Assessment Service

YOLOv8-seg damage detection + rule-based cost/severity engine + Llama-generated ILA report
narrative, feeding the "AI ILA" flow in `car-damage-insurance-web-app`'s admin console.

> Uses **YOLOv8-seg**, not the YOLOv11 named in the client's original spec — same `ultralytics`
> package either way, just a different checkpoint. Chosen for maturity/CPU stability; see
> `yolo-service/app.py`'s module docstring and `docs/ARCHITECTURE.md`.

**This is two services**, not one:

| | | Language | You'll edit this... |
|---|---|---|---|
| [`server/`](server/) | Main API — REST routes, database, cost engine, cause-check, corrections queue, Llama calls | **Node.js/Express** | ...often. This is where almost all day-to-day work happens. |
| [`yolo-service/`](yolo-service/) | YOLOv8 inference only — one endpoint | Python (unavoidable — see below) | ...rarely, once it's running. |

**Why two services / why Python at all**: Ultralytics YOLO (the vision model) only has a Python
runtime — there's no Node.js equivalent for training or running it. Everything else (the REST
API, the database, the cost/severity math, the cause-of-loss consistency check, calling Llama via
Ollama) is plain business logic with no ML-framework dependency, so it's all been written in
Node.js/Express instead. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) Section 2 for the full
reasoning, and Section 8 for GPU/server sizing.

**Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first** — it merges the client's official
technical spec with these implementation choices, and explains what's real vs. placeholder today.

**Want to actually annotate photos and train a model?** See
[`training/README.md`](training/README.md) — it walks through the annotation tool, a working
sample dataset, the fine-tune command, and the correction → retraining loop end to end.

**Just want to test what's built so far?** See [`TESTING.md`](TESTING.md) — a no-Python-needed
quick test using mock data, plus the full step-by-step for running both real services.

**Ready to put this on a real server?** See [`DEPLOYMENT.md`](DEPLOYMENT.md) — step-by-step VPS
setup (Node.js, Python, ports/firewall, nginx + HTTPS, `pm2`) for `server/` + `yolo-service/`.
Training itself doesn't happen on that VPS — see its "Ongoing maintenance" section.

## What's real vs. placeholder right now

- The Node.js API, database, cost engine, and cause-consistency rules are fully functional today.
- Damage **detection** runs on `cardd-seg.pt` by default — a real checkpoint pretrained on the
  published CarDD dataset (crack/dent/glass_shatter/lamp_broken/scratch/tire_flat), not a generic
  COCO model, so it detects real damage types out of the box. `is_placeholder_model: true` still
  shows in every response until you configure your own fine-tuned weights (`YOLO_CAR_WEIGHTS` etc.
  in `yolo-service/.env`) — it means "not fine-tuned on your photos / no part-assignment yet," not
  "doesn't know what damage is." See `docs/ARCHITECTURE.md` Section 5.1 and Section 9 (build phases).
- Report **narration** calls a local Ollama server; if it's not running, `/report` still responds
  with a clearly-labeled templated summary instead of failing.
- Llama fine-tuning (Section 5.2 of the architecture doc) isn't built yet — narration is
  zero-shot prompted today, which already works end to end.

## Setup

### 1. Main API (`server/`) — Node.js, no Python needed

Requires **Node.js ≥ 22.5** (for the built-in `node:sqlite` module — no native database driver to
compile, which is exactly the kind of Python/C++ build-toolchain requirement this move away from
FastAPI was meant to avoid).

```bash
cd ai-damage-assessment-service/server
npm install
cp .env.example .env
npm start
```

Runs on **http://localhost:8000** by default — same port and same API paths the frontend already
expects, so `car-damage-insurance-web-app` needs no changes.

### 2. YOLO inference (`yolo-service/`) — Python, only for this piece

Requires **Python 3.11+**.

```bash
cd ai-damage-assessment-service/yolo-service
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app:app --reload --port 8001
```

The first request will auto-download the `cardd-seg.pt` checkpoint via
`ultralytics` — needs internet access once, then it's cached locally. `server/.env`'s
`YOLO_SERVICE_URL` (default `http://localhost:8001`) is how the Node service finds this.

### 3. Optional: enable real report narration

```bash
# https://ollama.com
ollama serve
ollama pull llama3.1:8b
```
Without this, `/api/v1/report` still works, returning a templated (non-LLM) narrative.

## Typical request flow

1. `POST /api/v1/detect` (Node, forwards to `yolo-service/`) — multipart form, `photo` file +
   `vehicle_type` (`car` | `two_wheeler` | `commercial_vehicle`) → detection result.
2. `POST /api/v1/assess` — `{ vehicle, detections }` (the detections from step 1) → assessment
   result (per-part repair/replace + cost, total cost).
3. `POST /api/v1/report` — `{ claim_id, vehicle, reported_cause, detections, assessment }` →
   report result (narrative + cause-consistency flag).
4. When a handler edits anything in steps 1–3, the frontend calls `POST /api/v1/corrections` with
   the before/after — this is the retraining queue (`GET /api/v1/corrections/stats` shows how
   close you are to the retrain-volume threshold).

## Running the tests

None yet — this is a fresh scaffold. The natural first tests to add: `costEngine.js`'s
`scoreSeverity`/`decideAction` (pure functions, no I/O) and `causeCheck.js`'s
`checkCauseConsistency` (also pure) — both are plain JS functions, easy to unit test with any
Node test runner (`node --test`, Vitest, etc.). `yolo-service/app.py` and `llmReport.js` need
either a real checkpoint/Ollama instance or mocks to test meaningfully.

## Project layout

```
server/                         Node.js/Express — the main service
  src/
    server.js                    Entry point (app.listen)
    app.js                       Express app: CORS, JSON body parsing, routes mounted
    config.js                    Settings (env vars, see .env.example)
    db/
      database.js                 node:sqlite connection + table schema
      seed.js                      Sample parts-rate seed data
    models/
      costEngine.js                Severity + repair/replace + cost roll-up
      causeCheck.js                 Cause-of-loss consistency rules
      llmReport.js                  Llama/Ollama report narrative
    routes/
      detect.js                    Forwards photos to yolo-service/, persists uploads
      assess.js, report.js, corrections.js, partsRates.js
    schemas/
      constants.js, validation.js  Zod request validation + fixed label sets

yolo-service/                   Python — YOLOv8 inference ONLY
  app.py                         FastAPI wrapper, single /detect endpoint
  requirements.txt

training/                       Python — YOLO fine-tuning (unchanged, still Python — unavoidable)

docs/
  ARCHITECTURE.md                The full technical write-up (client spec + implementation notes)
```
