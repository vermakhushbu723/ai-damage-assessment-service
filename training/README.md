# Training pipeline: photos → annotations → trained model → retraining loop

This is the concrete, working version of docs/ARCHITECTURE.md Sections 2 and 5 — annotate real
photos, turn them into a YOLOv8-seg training set, fine-tune, and keep improving from handler
corrections. A tiny illustrative sample dataset is included so every step below runs today,
before you have real annotated photos.

> **Note:** the client's original spec (and docs/ARCHITECTURE.md's data-schema section) names
> YOLOv11. This project uses **YOLOv8-seg** instead — same `ultralytics` package/API, just a
> different checkpoint name — chosen for its maturity, documentation, and (per hands-on testing)
> more predictable CPU training behavior. Flag this to the client before going live; swapping
> back to a YOLO11 checkpoint later is a one-line change (`--base yolo11l-seg.pt` etc.) if needed.

## The full loop, end to end

```
 ┌─────────────────┐   ┌───────────────────┐   ┌──────────────────┐   ┌─────────────┐
 │ Annotation       │   │ prepare_dataset.py │   │     train.py     │   │  Deploy /   │
 │ Studio (web UI)  │──▶│ (stratified split) │──▶│ (YOLOv8-seg      │──▶│  shadow-mode│
 │ draw + export    │   │                    │   │  fine-tune)      │   │  validate   │
 └─────────────────┘   └───────────────────┘   └──────────────────┘   └──────┬──────┘
                                                                               │
        ┌──────────────────────────────────────────────────────────────────────┘
        │ once live: handlers correct AI output in the ILA screen
        ▼
 ┌───────────────────────────────┐
 │ POST /api/v1/corrections       │  (the retraining queue — a DB table)
 └───────────────┬─────────────────┘
                  ▼
 ┌──────────────────────────────────────┐
 │ export_corrections_for_retraining.py  │──▶ back into train.py (fine-tune again, from
 └──────────────────────────────────────┘     the last checkpoint, not from scratch)
```

## Step 1 — Annotate photos

Open **Annotation Studio** in the admin console
(`car-damage-insurance-web-app` → Intimation → Annotation Studio, or
`/admin/intimation/annotation-studio`). It's a from-scratch, self-hosted annotation tool (the
"in-house tool" option from Section 2.2 of the architecture doc — no CVAT/Labelbox account or
data-sharing needed to try this). Needs both the Node API (`server/`) and the web app running —
see the main [`README.md`](../README.md) or [`TESTING.md`](../TESTING.md) for how to start them.

1. Pick a **vehicle type** (car / two_wheeler / commercial_vehicle) at the top — this decides
   which `raw_pool/<vehicle_type>/` folder photos land in.
2. Click **"+ Upload Photos"** and select one or more JPG/PNG photos. They're uploaded to the
   Node API immediately and appear as thumbnails — no local file staging needed.
3. Click a thumbnail to open it in the editor, then click points on the photo to trace a polygon
   around a damage region, **"Finish Polygon"**, and tag it with a **class (damage type)** and
   **part**.
4. Repeat for every damage region in the photo, then click **"Save Annotation"**. This calls
   `POST /api/v1/annotations/photos/:id/save`, which writes the image + a YOLO-format `.txt`
   label straight into `training/raw_pool/<vehicle_type>/{images,labels}/` — the exact layout
   Step 2 below expects, no manual copying. The thumbnail gets a green "✓ annotated" badge;
   re-opening it later pre-loads the saved polygons for editing.
5. Repeat for as many photos as you want in this batch, across vehicle types as needed.

## Step 2 — Assemble a training set

Annotation Studio (Step 1) already writes into this exact layout, so if that's your only source
there's nothing to arrange by hand:

```
raw_pool/
  car/
    images/*.png|jpg
    labels/*.txt        (same basename as the matching image)
```

If you're also bringing in photos annotated elsewhere (a CVAT/Labelbox export converted via
`ultralytics.data.converter.convert_coco`, say), just drop those (image, label) pairs into the
same `raw_pool/<vehicle_type>/{images,labels}/` folders alongside what Annotation Studio saved —
`prepare_dataset.py` doesn't care which produced them. Then:

```bash
python scripts/prepare_dataset.py --raw-pool ./raw_pool --vehicle-type car \
  --train 0.8 --val 0.1 --test 0.1
```

This does the **stratified-by-damage-type** split from Section 2.1 (so a rare class like
"shatter" doesn't accidentally end up entirely in one split), and writes `data/car/data.yaml` +
populates `data/car/images/{train,val,test}` and `labels/{train,val,test}`.

## Step 3 — This repo's sample dataset (already prepared, try it now)

`data/car/` already has 4 illustrative image+label pairs (3 train, 1 val) so you can run the next
step immediately, without waiting for real annotated photos:

```
data/car/
  data.yaml
  images/train/  car_front_0001.png  car_frontleft_0002.png  car_right_0003.png
  images/val/    car_rear_0004.png
  labels/train/  car_front_0001.txt  car_frontleft_0002.txt  car_right_0003.txt
  labels/val/    car_rear_0004.txt
```

**Be clear with yourself about what this is**: the images are the survey app's vehicle
*silhouette guide* PNGs (reused because they're already in this repo), not real damage photos,
and the labels are hand-authored illustrative polygons, not real annotations. This exists purely
so you can see the exact file format and run the training command below without errors — it will
not produce a model that detects real damage. Replace it with your own annotated photos via
Step 1 as soon as you have them.

## Step 4 — Fine-tune YOLOv8-seg

```bash
cd ai-damage-assessment-service
python -m venv .venv-training                 # separate from yolo-service/.venv, same idea
.venv-training\Scripts\activate                # Windows; `source .venv-training/bin/activate` on Mac/Linux
pip install -r training/requirements.txt
python training/scripts/train.py --vehicle-type car --base yolov8n-seg.pt --epochs 150 --device cpu
```

`--base yolov8n-seg.pt` (nano) auto-downloads the stock COCO-pretrained checkpoint the first
time. This kicks off a `yolo segment train` run (1280px image size, early-stop patience 25) —
with this repo's tiny sample set it'll run in a couple of minutes on CPU and produce a
(not-yet-useful, sample-data-sized) checkpoint at
`training/runs/segment/car_finetune/weights/best.pt`, which is exactly what you'd point a real
run's larger dataset at too. For a real fine-tune, `--base yolov8s-seg.pt` (small, the project's
default) is a better accuracy/speed tradeoff — see the CPU warning below before picking anything
bigger.

> **⚠ CPU + a large base checkpoint (e.g. `yolov8m-seg.pt`/`yolov8l-seg.pt`, or the `yolo11l-seg.pt`
> this project used before switching to YOLOv8) will likely crash.**
> Found while testing the web UI's "Start Training" button: a large checkpoint at the default
> `batch=16`/`imgsz=1280` reliably crashes with an out-of-memory access violation (exit code
> `3221225477` / `0xC0000005` on Windows, no Python traceback — the crash happens inside
> OpenCV/PyTorch native code during the first batch, below where Python could catch it) on a
> 16GB CPU-only machine. **Fix: add `--batch 2`** (or however low your RAM needs). The web UI's
> "Start Training" button already defaults to `batch=2` on CPU automatically — this only matters
> if you're running `train.py` by hand. A big checkpoint is really meant for a GPU (see
> `docs/ARCHITECTURE.md` Section 8) — CPU is fine for proving the pipeline works (nano/small
> checkpoint), not for a real fine-tune with the larger variants.

Validate any checkpoint against a vehicle type's held-out set:
```bash
python training/scripts/train.py --vehicle-type car --base training/runs/segment/car_finetune/weights/best.pt --validate-only
```

Repeat Steps 1–4 separately for `two_wheeler` and `commercial_vehicle` (create their own
`data/two_wheeler/` and `data/commercial_vehicle/` folders the same way) — per the architecture
doc, these do **not** share a model after fine-tuning starts.

## Step 5 — Go live, then close the loop from real corrections

Once a validated checkpoint is deployed (`YOLO_CAR_WEIGHTS=training/runs/segment/car_finetune/weights/best.pt`
in `yolo-service/.env`) and handlers are correcting AI output in the AI ILA screen, those
corrections accumulate in the Node API's `corrections` table — a plain SQLite file at
`server/ai_damage_assessment.db` by default (`GET http://localhost:8000/api/v1/corrections/stats`
shows how many are pending). `export_corrections_for_retraining.py` reads that file directly with
Python's stdlib `sqlite3` (no Node/API call needed to run it, but the **Node API must have run at
least once** so the file and its `uploads/` photos exist). When you're ready to retrain (monthly,
or once the volume threshold is hit):

```bash
python training/scripts/export_corrections_for_retraining.py --run-id 2026-08-01
python training/scripts/train.py --vehicle-type car \
  --base training/runs/segment/car_finetune/weights/best.pt --epochs 60
```

The first command turns every unconsumed correction into a new (image, label) pair dropped
straight into `data/car/images/train` + `labels/train`, and marks those corrections as consumed
so the next run doesn't double-count them. The second command **fine-tunes from the last
checkpoint** (not from scratch) on top of the now-larger training set — this is the actual
mechanism behind "the model gets better every time a handler corrects it" from the original
architecture proposal.

Validate → shadow-mode → promote, per Section 5, before pointing production traffic at the new
checkpoint.
