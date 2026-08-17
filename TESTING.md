# How to test the AI ILA screen

There's no demo/mock mode anymore -- the AI ILA screen is fully dynamic and always calls the real
backend. This backend is **two services** — see [`README.md`](README.md) for why: a Node.js/Express
API (`server/`, no Python needed) and a small Python microservice that only does YOLOv8 inference
(`yolo-service/`). Both need to be running to test anything end to end.

## 1 — Start the main API (`server/`) — Node.js, no Python needed

```bash
cd ai-damage-assessment-service/server
npm install
copy .env.example .env           # Windows; `cp` on Mac/Linux
npm start
```
Requires **Node.js ≥ 22.5** (for the built-in `node:sqlite` module — no native database driver to
compile). Leave this running; it listens on **http://localhost:8000**, the same port and API
paths the frontend already expects.

## 2 — Install Python, then start the YOLO service (`yolo-service/`)

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

- First run auto-downloads `cardd-seg.pt` (~120MB, from Hugging Face — see `app.py`'s module
  docstring) — needs internet access once.
- Leave this terminal running. Open **http://localhost:8001/health** — if it responds, the
  service is up. `server/.env`'s `YOLO_SERVICE_URL` (default `http://localhost:8001`) is how the
  Node API finds it — nothing to change if you used the defaults above.

## 3 — Run the web app against it

In a **third** terminal:
```bash
cd car-damage-insurance-web-app
npm run dev
```
Open the printed URL (something like `https://localhost:5173` — Vite prints the exact port; your
browser will warn about the dev server's self-signed certificate, click through it). Go to
**AI ILA** in the sidebar, upload a real damage photo, fill in the claim/vehicle fields, and click
**"Run AI Assessment"**. You should see:
- A claim header bar, the **AI Analysis** photo viewer with numbered boxes over your actual photo,
  and the **AI Assessment Insights** panel (4 gauges + 4 info rows — all computed for real from
  your photo/detections, not mocked).
- A **yellow banner** explaining what checkpoint is running. With the default `cardd-seg.pt`, it
  detects real damage types (crack, dent, glass_shatter, lamp_broken, scratch, tire_flat) out of
  the box — the banner tells you whether it actually found any in your photo, and reminds you it
  isn't fine-tuned on *your* photos yet and doesn't assign parts (see
  `docs/ARCHITECTURE.md` Section 5.1).
- An editable "Detected Damage" table (empty if no damage was found above the confidence
  threshold — try a photo with more visible damage, or a lower angle/lighting condition), a "Cost
  Breakdown" table, and an "ILA Report" section.

**If "Run AI Assessment" fails immediately** ("Failed to fetch" or similar): the Node API and/or
yolo-service aren't reachable from the browser. Check:
- Both terminals from steps 1-2 are still running (`curl http://localhost:8000/health` and
  `curl http://localhost:8001/health` should both return `{"status":"ok"}`).
- You don't have **two Vite dev servers** running at once (e.g. one on 5173, another auto-bumped
  to 5174) — only the origin(s) listed in `server/.env`'s `CORS_ORIGINS` are allowed to call the
  API; a stray second dev server on an unlisted port gets silently CORS-blocked, which the browser
  surfaces as a generic "Failed to fetch". Stop the extra one, or add its port to `CORS_ORIGINS`
  and restart `server/`.

## 4 — Optional: real Llama report narrative

Without this, the "ILA Report" section still works but shows a templated (non-LLM) summary with a
banner saying so. To get an actual LLM-written narrative:
```bash
# https://ollama.com — install, then:
ollama serve
ollama pull llama3.2:3b
```
Re-run "Run AI Assessment" in the web app — the yellow "Ollama isn't reachable" banner should
disappear and the report text will read as natural prose rather than the templated bullet list.

## 5 — Test the correction → retraining loop

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

## What this actually proves

Running a photo through end to end proves the full pipeline works (upload → detect → assess →
report → correction queue) and that `cardd-seg.pt` finds real damage types on real photos.
It does **not** prove production-ready **detection accuracy** for *your* specific vehicles/photo
conditions — that comes from annotating your own photos and fine-tuning (`training/README.md`).
