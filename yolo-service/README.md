# YOLO Inference Service

The **only** Python you need to run for the AI ILA backend. Wraps Ultralytics
YOLO11-seg behind one endpoint (`POST /detect`) — no database, no cost logic,
no report generation. Everything else lives in `../server` (Node.js/Express).

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

The first request will auto-download the stock `yolo11l-seg.pt` checkpoint
(~50MB) via `ultralytics` — needs internet access once, then it's cached.

## Run

```bash
uvicorn app:app --reload --port 8001
```

The main backend (`../server`) expects this at `http://localhost:8001` by
default (`YOLO_SERVICE_URL` in `../server/.env`).

## What's real vs. placeholder

Runs on the stock COCO-pretrained checkpoint until you configure fine-tuned
weights (`YOLO_CAR_WEIGHTS` etc. in `.env`) — every response says so via
`is_placeholder_model: true`. Fine-tuning that checkpoint on your own
annotated damage photos is covered in `../training/README.md`.
