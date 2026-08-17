# YOLO Inference Service

The **only** Python you need to run for the AI ILA backend. Wraps Ultralytics
YOLOv8-seg (chosen over the newer YOLO11 for maturity/CPU stability — see
`app.py`'s module docstring) behind one endpoint (`POST /detect`) — no
database, no cost logic, no report generation. Everything else lives in
`../server` (Node.js/Express).

See `../docs/ARCHITECTURE.md` Section 8 for why YOLO specifically has to stay
in Python (Ultralytics has no Node.js equivalent for training or inference).

## Setup

Requires **Python 3.11+**.

```bash
cd yolo-service
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

The first request auto-downloads `cardd-seg.pt` (~120MB, from Hugging Face —
see `app.py`'s module docstring) — needs internet access once, then it's
cached locally.

## Run

```bash
uvicorn app:app --reload --port 8001
```

The main backend (`../server`) expects this at `http://localhost:8001` by
default (`YOLO_SERVICE_URL` in `../server/.env`).

## What's real vs. placeholder

Runs on `cardd-seg.pt` by default -- a real checkpoint pretrained on the
published CarDD dataset (6 damage classes: crack, dent, glass_shatter,
lamp_broken, scratch, tire_flat), not a generic COCO model, so damage
detection is genuinely meaningful out of the box. `is_placeholder_model:
true` still shows in every response until you configure your own
fine-tuned weights (`YOLO_CAR_WEIGHTS` etc. in `.env`) -- it means "not
fine-tuned on your photos / no part-assignment yet." Fine-tuning
`cardd-seg.pt` further on your own annotated damage photos is covered in
`../training/README.md`.
