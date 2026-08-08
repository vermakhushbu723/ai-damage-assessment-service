# AI ILA Model — Architecture & Implementation Notes

This document merges **the client's official technical specification** ("AI ILA Model —
Technical Specification", iBimassist MCMS) with the concrete implementation choices made in this
repo — most importantly, the backend split into **Node.js/Express (main service) + a small Python
microservice (YOLO inference only)**, so the team doesn't need deep Python knowledge to run or
extend the day-to-day API, database, and business logic.

Where this sits in the workflow: **Claim Intimation → Surveyor Appointment → Handler Allocation →
Claim Details → [AI ILA] → Handler ILA → FLA → Recommendation → Fee Bill**.

---

## 1. Two-model pipeline (not one monolithic model)

```
Survey Photos + Claim Metadata (cause of loss, vehicle details, policy info)
 │
 ▼
┌─────────────────────────┐
│ STAGE 1: Vision Model    │  YOLOv11 (Ultralytics, open weights)
│ Damage Detection         │  → detects part + damage type + severity
│ & Localization            │  per photo, with bounding boxes
└─────────────────────────┘
 │ (structured damage JSON)
 ▼
┌─────────────────────────┐
│ STAGE 2: Language Model │  LLaMA 3.1/3.2 (Meta, open weights)
│ ILA Report Generation    │  fine-tuned (LoRA/QLoRA) on
│                          │  damage JSON + cause of loss → ILA text
└─────────────────────────┘
 │
 ▼
 Draft ILA → shown to Claims Handler in "AI ILA" screen
 │
 ▼
 Handler edits/approves → becomes "Handler ILA"
 │
 ▼
 Diff (AI draft vs Handler final) → stored as new training example
```

**Why two models instead of one vision-language model (VLM):**
- Bounding boxes/masks give a traceable, auditable record of which damage the AI saw — needed for
  insurance/fraud review.
- Vision and text errors can be fixed independently (a bad photo detection vs. a badly worded
  sentence are different bugs, different fixes, different retraining sets — see Section 6).
- Both models are small enough to fully train and run on-prem/self-hosted, no external API
  calls — meets the offline/data-privacy requirement.
- (Later, once data volume is high, a VLM like Qwen2-VL/LLaVA can be evaluated as a v2 alternative
  — not needed for v1.)

This split is also why **YOLO11 and Llama never share weights or joint training** — YOLO11's JSON
output becomes part of Llama's *input context* for the next step. You can improve, replace, or
swap out either one independently without touching the other.

---

## 2. Service architecture: Node.js main backend + Python YOLO microservice

**This is the update this document exists to make**, since the original spec (Section 4.3 of the
client doc) assumed a single Python FastAPI service end to end. In practice:

```
                         ┌──────────────────────────────┐
   Web app (React) ───▶  │  server/  — Node.js/Express  │  ◀── owns: REST API, SQLite DB,
                         │  (the service you'll mostly   │       cost engine, cause-check,
                         │   read/edit day to day)       │       corrections/retraining queue
                         └──────────────┬───────────────┘
                                        │ HTTP (internal only)
                       ┌────────────────┴────────────────┐
                       ▼                                  ▼
        ┌───────────────────────────┐      ┌───────────────────────────┐
        │ yolo-service/  — Python   │      │ Ollama / vLLM — Llama     │
        │ FastAPI, ONE endpoint     │      │ served as a local HTTP    │
        │ (/detect). Ultralytics    │      │ API (localhost:11434);    │
        │ has no Node.js equivalent│      │ language-agnostic, so     │
        │ for training or running  │      │ Node calls it exactly the │
        │ YOLO — this is the       │      │ same way Python would.    │
        │ unavoidable Python part. │      │                           │
        └───────────────────────────┘      └───────────────────────────┘
```

**Why this split, concretely:**
- Ultralytics YOLO (training *and* inference) only has a Python runtime — there's no Node.js
  library that runs a `.pt` checkpoint directly. The only way to run YOLO from Node.js at all
  would be exporting to ONNX and using `onnxruntime-node`, which still needs Python to do the
  export and to fine-tune the model in the first place, and requires re-implementing image
  pre/post-processing by hand in JS (Ultralytics does this for you in Python). Given the team is
  more comfortable in JS, isolating YOLO behind one small, rarely-touched Python file
  (`yolo-service/app.py`) is simpler than fighting ONNX conversion.
- Ollama/vLLM expose Llama as a plain HTTP API (`POST /api/generate`) — there is nothing
  Python-specific about calling it. The Node service calls it with `fetch()` exactly the way the
  old Python service called it with `httpx`.
- Everything else — REST routes, request validation, the SQLite database, the cost/severity
  engine, the cause-consistency rule engine, the corrections/retraining queue — is plain business
  logic with zero ML-framework dependency, and now lives entirely in `server/` (Node.js/Express).
  **You should almost never need to open `yolo-service/app.py`** once it's running; day-to-day
  work (new fields, new rules, new endpoints) happens in `server/`.
- Training YOLO11 on your own annotated photos (Section 5) still requires Python + Ultralytics —
  there's no way around that for *training* specifically — but that's a periodic batch job run
  from `training/`, not a service you maintain continuously.

| Piece | Language | Where | Touches GPU? |
|---|---|---|---|
| Main API, DB, cost engine, cause-check, corrections queue | **Node.js/Express** | `server/` | No |
| YOLO11 inference | Python (FastAPI wrapper, per client spec 4.3) | `yolo-service/` | Yes, at inference time |
| YOLO11 fine-tuning | Python (Ultralytics CLI) | `training/` | Yes, at training time |
| Llama serving | Ollama/vLLM (not custom code) | wherever you install Ollama | Yes, at inference time |
| Llama fine-tuning (LoRA/QLoRA) | Python (Hugging Face `transformers` + `peft`) | *not built yet — see Section 9, Phase 3* | Yes, at training time |

---

## 3. Data schema

### 3.1 Damage JSON (output of Stage 1, input to Stage 2)

This is the client spec's canonical shape:

```json
{
  "claim_id": "CLM-2026-00123",
  "vehicle": {
    "make": "Maruti Suzuki",
    "model": "Swift",
    "year": 2021,
    "registration_no": "MH12AB1234"
  },
  "cause_of_loss": "Accidental Collision",
  "photos": [
    {
      "photo_id": "P1",
      "angle": "front_left",
      "detections": [
        {
          "part": "front_bumper",
          "damage_type": "crack",
          "severity": "moderate",
          "confidence": 0.91,
          "bbox": [0.12, 0.30, 0.44, 0.55]
        },
        {
          "part": "left_headlight",
          "damage_type": "broken",
          "severity": "severe",
          "confidence": 0.88,
          "bbox": [0.05, 0.20, 0.22, 0.38]
        }
      ]
    }
  ]
}
```

**Note on `severity` and the current scaffold:** the client spec has annotators tag `severity`
directly during CVAT annotation (Section 4 below) — i.e. it's a label the fine-tuned model learns
to predict, same as `part`/`damage_type`. The scaffold implemented in this repo doesn't have a
fine-tuned model yet (Section 8), so **`server/src/models/costEngine.js` computes a placeholder
severity** from a simple `mask_area_ratio` threshold rule instead, purely so the rest of the
pipeline (cost roll-up, report narrative) has something to consume end to end today. Once you have
enough CVAT-annotated `severity` labels, retrain Stage 1 to predict severity directly per the spec
and remove the threshold-rule stand-in — nothing downstream needs to change, since everything past
detection just consumes a `severity` string either way.

**Note on `bbox` vs. masks:** the client spec's example uses a 4-point bounding box. This repo's
schemas (`server/src/schemas/validation.js`) additionally support a full segmentation
`mask_polygon` (list of points, not just a box) alongside the same `bbox` idea, and a derived
`mask_area_ratio` — segmentation masks give a more precise damage-area estimate than a box, which
matters for severity scoring. Use `-seg` (segmentation) YOLO11 checkpoints, not the plain
detection variant, to get masks; a bounding box is trivially derivable from a mask's min/max
coordinates if you ever need one.

### 3.2 Fixed label sets (must be finalized before annotation starts)

Straight from the client spec — **freeze these before annotating a single photo**, since changing
a label taxonomy after 500+ photos are annotated means re-annotating:

- **Parts list**: front bumper, rear bumper, bonnet, front/rear doors (L/R), fenders (L/R),
  headlights (L/R), taillights (L/R), windshield, rear glass, side mirrors, roof, boot/trunk,
  wheels/rims, undercarriage — extend as per your survey checklist.
- **Damage types**: dent, scratch, crack, broken, shattered, misaligned, missing part,
  rust/corrosion, deep dent (structural), paint damage.
- **Severity**: minor / moderate / severe (define clear visual criteria for each in the annotation
  guideline doc — Section 4 — so labeling stays consistent across annotators).
- **Cause of loss**: pull directly from the existing Claim Intimation dropdown (accident, fire,
  theft, flood, riot, natural calamity, etc.) — keep it identical to what's already used elsewhere
  in MCMS. The current `causeCheck.js` rule table (Section 7) uses a slightly different, more
  granular set (`front_collision`, `rear_ended`, `side_collision_left`, ...) as a stand-in; align
  these with the real Claim Intimation dropdown values once annotation starts.

> The scaffold's `DAMAGE_TYPES` constant (`server/src/schemas/constants.js`) currently has
> `dent, scratch, crack, shatter, deformation, tear, unknown` — a slightly different list than the
> client spec's ten types above. Reconcile these before annotating: either adopt the spec's list
> verbatim (recommended, since it's the client's authoritative taxonomy) or document why the
> scaffold's list differs, then update `constants.js` and the YOLO `data.yaml` class list
> together so they never drift apart.

### 3.3 ILA text training pair (input to Stage 2 fine-tuning)

```json
{
  "input": {
    "damage_json": "<as above>",
    "cause_of_loss": "Accidental Collision"
  },
  "output_ila_text": "The vehicle sustained moderate damage to the front bumper (crack) and severe damage to the left headlight (broken)..."
}
```

Built from **historical claims** (Phase 3, Section 9) — you need a corpus of
`(damage_json + cause_of_loss) → human-written ILA text` pairs before Llama fine-tuning can start.
Until that corpus exists, `server/src/models/llmReport.js` uses a **zero-shot prompted** Llama
(full context handed to it at request time, no fine-tuning) — this produces usable narratives
today and is explicitly allowed as a v1 approach by the client spec (Section 4.2: fine-tuning
Llama is listed as improving quality, not as a hard prerequisite for the pipeline to work).

---

## 4. Annotation pipeline

- **Tool**: [CVAT](https://github.com/cvat-ai/cvat) (Computer Vision Annotation Tool) — open
  source, self-hostable, fully offline. Alternative: Roboflow (has a free self-hosted option too).
- **Process**:
  1. Deploy CVAT on your internal server.
  2. Upload historical survey photos (needs surveyor/handler consent + data governance sign-off,
     since these are real claim images).
  3. Annotators (can be your survey QC team) draw bounding boxes or segmentation masks per photo,
     tag each with `part`, `damage_type`, `severity` from the fixed label sets (Section 3.2).
  4. Export annotations in **YOLO format** (CVAT supports this natively) — this becomes the
     training set for Stage 1. `training/scripts/prepare_dataset.py` in this repo already expects
     this exact format (see `training/README.md`).
  5. **Minimum viable dataset**: aim for **2,000–5,000 annotated photos** to start (more is
     better; use augmentation — rotation, brightness, crop — to stretch a smaller set).
  6. Maintain an **annotation guideline doc** (with example images per severity level) so multiple
     annotators stay consistent — inconsistent labels directly hurt model accuracy.

---

## 5. Training pipeline

### 5.1 Stage 1 — YOLOv11 damage detector

- Framework: `ultralytics` Python package (`pip install`, runs offline once weights are downloaded
  once) — see `training/README.md` and `training/scripts/train.py` in this repo, already wired to
  this exact workflow.
- Start from COCO-pretrained YOLOv11 weights (`yolo11l-seg.pt`, matching `yolo-service`'s default),
  fine-tune on your annotated dataset.
- Standard supervised (instance segmentation) training — no custom research needed, this is a
  well-trodden path.
- Output: a `.pt` model file, pointed at by `yolo-service/.env`'s `YOLO_CAR_WEIGHTS` /
  `YOLO_TWO_WHEELER_WEIGHTS` / `YOLO_CV_WEIGHTS` (one fine-tuned checkpoint per vehicle type).

### 5.2 Stage 2 — LLaMA ILA generator

**Not built yet in this scaffold** — tracked as Phase 3 (Section 9). When you get there:
- Framework: Hugging Face `transformers` + `peft` (for LoRA/QLoRA) — keeps GPU memory requirement
  manageable (Section 8).
- Base model: LLaMA 3.1-8B (or 3.2, depending on what's available at setup time) — open weights,
  runs offline via Ollama or vLLM for inference.
- Fine-tune on the `(damage_json + cause_of_loss) → ila_text` pairs described in Section 3.3.
- Instruction-format prompt template — the same shape `llmReport.js` already builds for zero-shot
  prompting today becomes the fine-tuning input format, so no prompt-engineering work is thrown
  away when you move from zero-shot to fine-tuned.

---

## 6. Integration into MCMS workflow

1. At the **Claim Details** stage, once survey photos are uploaded, the web app's backend sends
   photos + claim metadata to `server/` (`POST /api/v1/detect` per photo).
2. `server/` forwards each photo to `yolo-service/` and gets back Stage 1's damage JSON, then
   calls `POST /api/v1/assess` (cost engine) and `POST /api/v1/report` (Stage 2 narrative +
   cause-consistency).
3. This populates the **AI ILA** screen (`AiIlaAssessmentPage.jsx` in the web app) for the Claims
   Handler.
4. Handler reviews, edits if needed, and submits — this becomes **Handler ILA**.
5. The frontend calls `POST /api/v1/corrections`, logging
   `{claim_id, photo_id, vehicle_type, ai_output, corrected_output, reviewer_id, reason}` into the
   `corrections` table — this **is** the feedback/retraining queue.

---

## 7. Retraining loop (feedback from handler corrections)

- **Do not retrain on every single correction** — risk of overfitting to one-off edits and model
  instability.
- **Batch retraining cadence**: collect corrections weekly or monthly (whatever volume gives a
  meaningful batch, e.g. 200+ new examples). `GET /api/v1/corrections/stats` (implemented) reports
  the current pending count and whether `RETRAIN_VOLUME_THRESHOLD` has been hit.
- **Classify each correction before using it for retraining** (this is new detail from the client
  spec, not yet automated in the scaffold — currently every correction lands in one table
  undifferentiated; add a `correction_type` column/step before your first real retraining run):
  - **Detection error** (AI missed/misidentified damage) → goes back to the annotation team to
    verify and add to the YOLO training set.
  - **Text/narrative error** (damage was detected correctly, but wording/estimate was off) → goes
    into the LLaMA fine-tuning set.
- **Versioning**: each retrain produces a new model version (`models/yolo/car_v2`, etc. — see
  Section 8's model registry note). Run it against a held-out validation set (and ideally a short
  A/B period against the live model) before fully replacing the production model.
- **Track accuracy over time** — e.g. % of AI ILA drafts accepted without edit, average edit
  distance per claim — to know if retraining is actually improving things. Not implemented yet;
  a straightforward addition once `corrections` has enough volume to compute trends from.

Cross-reference: `server/src/routes/corrections.js` implements the queue itself;
`export_corrections_for_retraining.py` (in `training/scripts/`) already exports corrections into
the annotation format YOLO fine-tuning expects — this is the "detection error" half of the
classification above, wired end to end today.

---

## 8. Server & GPU infrastructure

**This section directly answers "what do we need for server/GPU" — read this before provisioning
anything.**

### 8.1 GPU sizing

**One mid-range GPU with ≥24GB VRAM is enough for both** YOLOv11-seg fine-tuning and LLaMA-3.1-8B
LoRA/QLoRA fine-tuning — you do not need separate GPUs for each model, and you do not need
multiple GPUs at v1. Concretely:
- Training YOLO11l-seg at `imgsz=1280` on a few thousand images: comfortably fits in 24GB.
- LoRA/QLoRA fine-tuning an 8B-parameter Llama (4-bit quantized base + low-rank adapters, which is
  what QLoRA specifically means) needs roughly 8–12GB VRAM, not the 60GB+ full fine-tuning would
  need — this is the entire reason the spec calls out LoRA/QLoRA specifically rather than full
  fine-tuning.
- **Inference** (production serving, not training) is much lighter than training for both models:
  YOLO11-seg inference is well under 1GB VRAM per request; Llama-8B served via Ollama in its
  default 4-bit quantization is roughly 5–6GB resident. Both can run concurrently on one 24GB card
  with headroom to spare.
- Reasonable concrete options: a single **RTX 4090** (24GB, on-prem) or an **A10 (24GB)** /
  **A100 (40/80GB)** cloud instance. Anything at or above 24GB VRAM covers this v1 scope.

### 8.2 Open question to confirm before buying/provisioning anything

The client spec explicitly flags this and it hasn't been answered yet: **does "offline" mean (a)
"no third-party API calls" (a cloud GPU VM is fine, as long as nothing calls out to OpenAI/
Anthropic/etc.), or (b) "fully on-prem, no cloud infrastructure at all" (requires a physical GPU
server in your own datacenter)?** This materially changes procurement:
- If (a): a cloud GPU VM (AWS `g5.xlarge`/`g5.2xlarge`, Azure `NC A100 v4`, or similar, ~24GB+
  VRAM) can be provisioned in minutes, billed hourly, and scaled down between training runs.
- If (b): you need to purchase/rack a physical GPU server, which is a weeks-long procurement and
  ops process, not something that can start today.

**Get this confirmed with the client/ops team before committing to either path** — everything in
this document works identically either way (it's a deployment target choice, not an architecture
choice), but the timeline and budget differ substantially.

### 8.3 Serving architecture (who runs where)

- **`server/` (Node.js/Express)** needs **no GPU at all** — it's a plain REST API + SQLite
  database + business logic. Runs fine on the smallest/cheapest VM you have, or even alongside the
  GPU box if that's operationally simpler.
- **`yolo-service/` (Python FastAPI wrapper around YOLO11)** needs GPU access at inference time —
  runs on the GPU box, one process, serving `POST /detect` to `server/` over an internal network
  call (never exposed to the internet or the browser directly).
- **Ollama or vLLM** (Llama serving) also needs GPU access — can run on the same GPU box as
  `yolo-service` (both fit in 24GB, Section 8.1) or a separate instance if you'd rather isolate
  them operationally.
- **Training runs** (both YOLO fine-tuning and, later, Llama LoRA fine-tuning) are periodic batch
  jobs, not always-on services — schedule them during low-traffic windows on the same GPU box
  used for inference, or add a second GPU later if concurrent training + production serving
  becomes a real bottleneck. Not a v1 concern.
- **Model registry**: even a simple versioned folder structure (`models/yolo/car_v1/`,
  `models/yolo/car_v2/`, `models/llama/v1/`, …) works initially — no need for heavy MLOps tooling
  (MLflow, etc.) at v1, per the client spec.

---

## 9. Suggested build phases (client spec, with current status)

| Phase | Scope | Status in this repo |
|---|---|---|
| 1 | Finalize label sets (parts/damage types/severity), set up CVAT, annotate first ~2,000 photos | **Not started** — reconcile `constants.js`'s damage-type list with Section 3.2 first |
| 2 | Train & validate YOLOv11 damage detector; build inference API | **Scaffolded**: `yolo-service/` API is built and running on the stock COCO checkpoint (placeholder, no real damage classes yet); `training/` has the fine-tune script ready for when annotated data exists |
| 3 | Build damage JSON → ILA text training pairs from historical claims; fine-tune LLaMA; build inference API | **Not started** — `server/src/models/llmReport.js` currently does zero-shot prompting (works today, no fine-tuning yet) |
| 4 | Integrate both into "AI ILA" screen in MCMS; log handler corrections | **Done**: `AiIlaAssessmentPage.jsx` + the full `server/` API + `corrections` table are wired end to end |
| 5 | Set up batch retraining pipeline + versioning + validation process | **Partially done**: `corrections` queue + stats endpoint exist; correction-type classification, versioned model promotion, and A/B validation are not automated yet (Section 7) |

---

## 10. API surface (server/, Node.js/Express)

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/detect` | Upload photo + vehicle type → forwards to `yolo-service/`, returns detections (JSON, Section 3.1) |
| `POST /api/v1/assess` | Detections + vehicle make/model/year/region → repair/replace decisions + cost breakdown (Parts Rate DB lookup) |
| `POST /api/v1/report` | Assessment + claim metadata → Llama-generated ILA narrative + cause-consistency note |
| `POST /api/v1/cause-check` | Detections + reported cause → consistency score/flags (used internally by `/report`, also exposed standalone for the fraud-rules engine to call) |
| `POST /api/v1/corrections` | Log a handler's correction (structured diff) into the retraining queue |
| `GET /api/v1/corrections/stats` | Retraining queue size, oldest pending correction, whether the volume threshold has been hit |
| `GET /api/v1/parts-rates` | Query the Parts Rate Database (make/model/year/part/region) |

Internal only (never called from the browser): `POST /detect` on `yolo-service/` (default
`http://localhost:8001`).

See `README.md` (this folder), `server/README.md`, and `yolo-service/README.md` for how to install
and run each piece locally.
