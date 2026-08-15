# How to test the AI ILA screen

Two tracks: a **quick test that needs nothing installed** (works right now, on your laptop, no
Python), and a **full test** with the real YOLOv8 + Llama backend running.

This backend is **two services** — see [`README.md`](README.md) for why: a Node.js/Express API
(`server/`, no Python needed) and a small Python microservice that only does YOLOv8 inference
(`yolo-service/`). Track 2 below starts both.

## Track 1 — Quick test, no Python needed (do this first)

This exercises the entire UI — photo viewer, numbered damage boxes, gauges, cost table, report —
using mock data generated in the browser. Nothing is installed, nothing is downloaded.

1. Open a terminal in `car-damage-insurance-web-app/` and run:
   ```bash
   npm install   # only needed the first time
   npm run dev
   ```
2. Open the printed URL (something like `https://localhost:5173` or `5174` — Vite prints the
   exact port). Your browser will warn about the dev server's self-signed certificate; click
   through it (Advanced → Proceed).
3. Log into the admin panel (or navigate directly to `/admin/intimation/ai-ila`).
4. Click **AI ILA** in the left sidebar.
5. Click the green **"▶ Run Demo (no backend needed)"** button.
6. You should see, within ~1.5 seconds:
   - A claim header bar ("2024 Toyota Camry XSE", claim/policy numbers, status pills).
   - The **AI Analysis** photo viewer with 7 numbered colored boxes over the sample image, each
     with a label ("Front Bumper / Cracked", "Right Headlight / Intact", etc.) — click a box or
     its row in the table below to highlight it.
   - The **AI Assessment Insights** panel with 4 gauges (AI Confidence, Damage Score, Fraud
     Probability, Image Quality) and 4 info rows (Duplicate Images, Previous Claim Match, AI
     Processing Time, Est Repair Duration).
   - A thumbnail strip below the photo — each thumbnail has its own angle dropdown (Front, Left,
     Rear, Odometer, ...) and a "Set primary" link to switch which photo the (mock) detection ran
     against.
   - Below that: an editable "Detected Damage" table, a "Cost Assessment" table with a total, and
     an "ILA Report" with a narrative + cause-consistency banner.
7. Try uploading your **own** photo via "Primary inspection photo" instead of the sample — the
   photo displays immediately (no AI run needed just to see it), and you can pick its angle from
   the dropdown. Clicking **"Run AI Assessment"** on your own photo will fail with a clear error
   (since there's no backend yet) — that's expected on this track; use "Run Demo" to see the full
   UI without a backend, and Track 2 below once you want a real photo actually analyzed.

**If anything looks broken** on this track (layout, missing image, console errors), that's a real
bug in the frontend, independent of Python/YOLO/Llama — report exactly what you see.

## Track 2 — Full test, with the real AI service

This actually runs a photo through YOLOv8 and (optionally) generates a report via Llama. It needs
**two terminals running at once** — the Node API and the Python YOLO service — plus a third for
the web app.

### 2.1 — Start the main API (`server/`) — Node.js, no Python needed

```bash
cd ai-damage-assessment-service/server
npm install
copy .env.example .env           # Windows; `cp` on Mac/Linux
npm start
```
Requires **Node.js ≥ 22.5** (for the built-in `node:sqlite` module — no native database driver to
compile). Leave this running; it listens on **http://localhost:8000**, the same port and API
paths the frontend already expects.

### 2.2 — Install Python, then start the YOLO service (`yolo-service/`)

Your laptop may currently only have the **Microsoft Store's Python stub** (the "Python was not
found; install from the Microsoft Store" message) — that's not a real Python installation and
won't run this piece. Install the real thing:

- Go to **https://www.python.org/downloads/**, download the latest **Python 3.11 or 3.12**
  installer (not 3.13+ for now — some ML packages lag behind the newest release).
- Run the installer. **Check "Add python.exe to PATH"** on the first screen before clicking
  Install — this is the step people most often miss.
- Close and reopen your terminal, then confirm it worked:
  ```bash
  python --version
  pip --version
  ```
  Both should print a real version number, not the Store-redirect message.

Then, in a **second** terminal:
```bash
cd ai-damage-assessment-service/yolo-service
python -m venv .venv
.venv\Scripts\activate            # Windows PowerShell/cmd
# source .venv/bin/activate        # if you're ever on Mac/Linux instead
pip install -r requirements.txt
copy .env.example .env            # Windows; `cp` on Mac/Linux
uvicorn app:app --reload --port 8001
```

- First run downloads the stock YOLOv8 checkpoint (~50MB, needs internet once).
- Leave this terminal running. Open **http://localhost:8001/health** — if it responds, the
  service is up. `server/.env`'s `YOLO_SERVICE_URL` (default `http://localhost:8001`) is how the
  Node API finds it — nothing to change if you used the defaults above.

### 2.3 — Run the web app against it

In a **third** terminal:
```bash
cd car-damage-insurance-web-app
npm run dev
```
Open the app, go to AI ILA, upload a real photo, fill in the claim/vehicle fields, and click
**"Run AI Assessment"**. You should see:
- A **yellow banner**: "Running on the stock YOLOv8 checkpoint..." — expected, since there's no
  fine-tuned damage-detection model yet (that needs your own annotated photos, see
  `training/README.md`). The detection itself will just outline "a vehicle," not real damage —
  this step is proving the *pipeline* works end to end, not that damage detection is accurate yet.
- Real, measured **AI Processing Time** and **Image Quality** (computed from your actual photo).
- A cost table and report using the placeholder/rule logic described in `docs/ARCHITECTURE.md`.

### 2.4 — Optional: real Llama report narrative

Without this, the "ILA Report" section still works but shows a templated (non-LLM) summary with a
banner saying so. To get an actual LLM-written narrative:
```bash
# https://ollama.com — install, then:
ollama serve
ollama pull llama3.1:8b
```
Re-run "Run AI Assessment" in the web app — the yellow "Ollama isn't reachable" banner should
disappear and the report text will read as natural prose rather than the templated bullet list.

### 2.5 — Test the correction → retraining loop

1. In the "Detected Damage" table, edit a part name or damage type, or remove a row.
2. Click **"Save Correction"** — it should turn into "Saved to retraining queue ✓".
3. Check it landed in the queue:
   ```bash
   curl http://localhost:8000/api/v1/corrections/stats
   ```
4. Export it into the training set (see `training/README.md` for the full picture):
   ```bash
   python training/scripts/export_corrections_for_retraining.py --run-id test-1
   ```
   It should print `car: 1 new samples` (or however many corrections you saved) and show a new
   `correction_<id>.png` + `.txt` pair under `training/data/car/images/train` and `labels/train`.

## What each track actually proves

| Track | Proves | Doesn't prove |
|---|---|---|
| 1 (no Python) | The UI renders correctly, gauges/overlays/tables work, no frontend bugs | Real damage detection, real cost lookup, real LLM report |
| 2 (with Python) | The full pipeline runs end to end, corrections reach the retraining queue | **Detection accuracy** — that only comes from fine-tuning on your own annotated photos (`training/README.md`) |
