"""Minimal YOLOv8-seg inference microservice.

Uses YOLOv8-seg rather than the newer YOLO11-seg -- same `ultralytics`
package/API either way (just a different checkpoint name), chosen for
YOLOv8's maturity/stability and CPU-friendliness on this project's
offline/on-prem deployment target (better docs, huge community, more
predictable CPU training behavior) over YOLO11's marginally newer
architecture. This is a deliberate deviation from the client's original
spec, which named YOLOv11 -- see docs/ARCHITECTURE.md's data schema
section for the reasoning; flag it to the client before going live.

Default checkpoint ("cardd-seg.pt") is a YOLOv11-seg model pretrained on
CarDD (Wang et al., "CarDD: A New Dataset for Vision-based Car Damage
Detection") by harpreetsahota on Hugging Face -- auto-downloaded on first
use (see _ensure_downloaded below). This is a real, published,
damage-specific model (6 classes: crack, dent, glass shatter, lamp broken,
scratch, tire flat), NOT a generic COCO-pretrained checkpoint -- unlike the
old default (bare "yolov8n-seg.pt", which only knows COCO's 80 everyday-
object classes like "car"/"truck" and has never seen a dent or a scratch),
this one gives genuinely useful damage detections out of the box, before
you've annotated or fine-tuned anything on your own photos. It still isn't
fine-tuned on *your* IBimaAssist photos and doesn't do part-assignment
(bumper/door/etc.) -- see the module-level TODO in `detect()` below -- so
`is_placeholder_model` still comes back `true` until you fine-tune your own
checkpoint (training/README.md), it just now means "not fine-tuned on your
data" rather than "doesn't know what damage looks like at all."

This is the ONLY Python you need to run/maintain for the AI ILA backend.
Everything else -- the REST API, database, cost engine, cause-check,
Llama narration -- is the Node.js/Express service in ../server. See
../docs/ARCHITECTURE.md Section 8 ("Server & Infra") for why this one piece
has to stay in Python: Ultralytics YOLO only has a Python runtime, there is
no Node.js equivalent for *training or running* a YOLO model directly.

This file intentionally does nothing except load a YOLO checkpoint and run
inference on one uploaded photo -- no database, no CORS (it's only ever
called server-to-server from ../server, never from a browser), no cost
logic. Keeping its surface area this small is the point: it's the smallest
possible amount of Python between you and YOLO.
"""

from __future__ import annotations

import logging
import os
import urllib.request
from pathlib import Path
from threading import Lock

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image
import io

load_dotenv()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="YOLO Inference Service", version="0.1.0")

# COCO class ids that plausibly represent "a vehicle" -- fallback path for
# whatever checkpoint you point this at that ISN'T damage-aware (e.g. if you
# override YOLO_CAR_WEIGHTS back to a bare COCO checkpoint).
_COCO_VEHICLE_CLASS_NAMES = {"car", "truck", "bus", "motorcycle", "bicycle"}

# Canonical damage-type taxonomy -- the CarDD dataset's 6 classes (see module
# docstring), normalized to snake_case. This is what the default checkpoint
# actually detects, so it's now the project's real, model-grounded taxonomy
# rather than a client-spec-derived guess. Must stay in sync with:
#   server/src/schemas/constants.js's DAMAGE_TYPES / TRAINABLE_DAMAGE_TYPES
#   car-damage-insurance-web-app's AnnotationStudioPage.jsx DAMAGE_TYPES
#   training/scripts/{prepare_dataset,export_corrections_for_retraining}.py's DAMAGE_TYPE_NAMES
#   training/data/<vehicle_type>/data.yaml's `names:`
_DAMAGE_TYPES = {"crack", "dent", "glass_shatter", "lamp_broken", "scratch", "tire_flat", "unknown"}

# Maps a loaded model's raw class-name strings (whatever the checkpoint's
# own `model.names` says) to our canonical snake_case taxonomy above. Covers
# both the CarDD default checkpoint's "glass shatter" style spacing and
# already-normalized names (a fine-tuned checkpoint trained on our own
# exported labels would already use snake_case).
_CLASS_NAME_ALIASES = {
    "glass shatter": "glass_shatter",
    "lamp broken": "lamp_broken",
    "tire flat": "tire_flat",
}

# Well-known checkpoints this service can fetch on its own the first time
# they're requested, keyed by the bare filename you'd set e.g.
# YOLO_CAR_WEIGHTS to. Ultralytics only auto-downloads its OWN stock
# checkpoints (yolov8n.pt etc.) -- anything else, including this CarDD one,
# we have to fetch ourselves before handing the path to YOLO(...).
_DOWNLOADABLE_CHECKPOINTS = {
    "cardd-seg.pt": "https://huggingface.co/harpreetsahota/car-dd-segmentation-yolov11/resolve/main/best.pt",
}

_WEIGHTS_BY_VEHICLE_TYPE = {
    "car": os.getenv("YOLO_CAR_WEIGHTS", "cardd-seg.pt"),
    "two_wheeler": os.getenv("YOLO_TWO_WHEELER_WEIGHTS", "cardd-seg.pt"),
    "commercial_vehicle": os.getenv("YOLO_CV_WEIGHTS", "cardd-seg.pt"),
}
_CONF_THRESHOLD = float(os.getenv("YOLO_CONF_THRESHOLD", "0.25"))

_models: dict[str, object] = {}
_lock = Lock()


def _ensure_downloaded(weights_path: str) -> None:
    """Fetches a known checkpoint (see _DOWNLOADABLE_CHECKPOINTS) into the
    current directory if it isn't already there. No-op for anything else
    (a fine-tuned checkpoint path, or a name Ultralytics itself knows how
    to auto-download, like the stock "yolov8n-seg.pt").
    """
    if weights_path not in _DOWNLOADABLE_CHECKPOINTS:
        return
    if Path(weights_path).exists():
        return
    url = _DOWNLOADABLE_CHECKPOINTS[weights_path]
    logger.info("Downloading %s from %s (one-time, ~120MB)...", weights_path, url)
    tmp_path = f"{weights_path}.part"
    urllib.request.urlretrieve(url, tmp_path)
    os.replace(tmp_path, weights_path)
    logger.info("Saved %s", weights_path)


def _is_own_finetune(weights_path: str) -> bool:
    # A fine-tuned checkpoint from training/scripts/train.py lives inside a
    # directory (e.g. "training/runs/segment/car_v3/weights/best.pt"); any
    # bare filename with no directory is a stock/public checkpoint (either
    # Ultralytics' own COCO weights or the CarDD one above) -- not fine-tuned
    # on *your* annotated photos yet.
    return Path(weights_path).parent != Path(".")


def _get_model(vehicle_type: str):
    if vehicle_type in _models:
        return _models[vehicle_type]

    with _lock:
        if vehicle_type in _models:  # re-check after acquiring the lock
            return _models[vehicle_type]

        try:
            from ultralytics import YOLO
        except ImportError as exc:  # pragma: no cover - environment issue, not a code bug
            raise RuntimeError(
                "ultralytics is not installed. Run `pip install -r requirements.txt`."
            ) from exc

        weights_path = _WEIGHTS_BY_VEHICLE_TYPE[vehicle_type]
        logger.info("Loading YOLO checkpoint for %s: %s", vehicle_type, weights_path)
        try:
            _ensure_downloaded(weights_path)
            model = YOLO(weights_path)
        except Exception as exc:  # noqa: BLE001 - surface as a clean API error
            raise RuntimeError(f"Failed to load YOLO checkpoint '{weights_path}': {exc}") from exc

        _models[vehicle_type] = model
        return model


def _estimate_mask_area_ratio(polygon_xy: list[list[float]]) -> float:
    """Shoelace-formula polygon area, normalized (0-1) since coords are already normalized."""
    if len(polygon_xy) < 3:
        return 0.0
    area = 0.0
    n = len(polygon_xy)
    for i in range(n):
        x1, y1 = polygon_xy[i]
        x2, y2 = polygon_xy[(i + 1) % n]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2.0


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/detect")
async def detect(vehicle_type: str = Form(...), photo: UploadFile = File(...)) -> dict:
    if vehicle_type not in _WEIGHTS_BY_VEHICLE_TYPE:
        raise HTTPException(status_code=422, detail=f"Unknown vehicle_type '{vehicle_type}'.")

    image_bytes = await photo.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded photo is empty.")

    weights_path = _WEIGHTS_BY_VEHICLE_TYPE[vehicle_type]
    is_own_finetune = _is_own_finetune(weights_path)

    try:
        model = _get_model(vehicle_type)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    results = model.predict(source=image, conf=_CONF_THRESHOLD, verbose=False)
    result = results[0]

    detections: list[dict] = []
    found_real_damage_class = False

    if result.masks is not None:
        class_names = result.names
        polygons = result.masks.xyn  # normalized polygon points per instance
        boxes = result.boxes

        for i, polygon in enumerate(polygons):
            cls_id = int(boxes.cls[i].item())
            confidence = float(boxes.conf[i].item())
            raw_class_name = class_names.get(cls_id, str(cls_id))
            normalized_class_name = _CLASS_NAME_ALIASES.get(raw_class_name, raw_class_name)
            polygon_points = [[float(x), float(y)] for x, y in polygon.tolist()]

            if normalized_class_name in _DAMAGE_TYPES:
                # The model's class IS a real damage type (either the CarDD
                # default checkpoint or your own fine-tune trained on the
                # same taxonomy) -- part assignment (bumper/door/etc.) is a
                # separate step not implemented in this scaffold; plug your
                # part-segmentation/geometry step in here.
                found_real_damage_class = True
                detections.append({
                    "part": "unassigned",  # TODO: wire in part-region assignment
                    "damage_type": normalized_class_name,
                    "mask_polygon": polygon_points,
                    "confidence": confidence,
                    "mask_area_ratio": _estimate_mask_area_ratio(polygon_points),
                })
            elif raw_class_name in _COCO_VEHICLE_CLASS_NAMES:
                # Fallback for a non-damage-aware checkpoint (e.g. you
                # override YOLO_CAR_WEIGHTS back to a bare COCO model) --
                # honestly report a whole-vehicle outline instead of
                # pretending we found real damage.
                detections.append({
                    "part": "whole_vehicle",
                    "damage_type": "unknown",
                    "mask_polygon": polygon_points,
                    "confidence": confidence,
                    "mask_area_ratio": 1.0,
                })
            # else: class isn't a damage type or a vehicle -- skip it.

    return {
        "detections": detections,
        # True until you fine-tune your own checkpoint on your annotated
        # photos (training/README.md) -- even though the CarDD default
        # already detects real damage types, it wasn't trained on *your*
        # cars/damage patterns and doesn't do part assignment yet.
        "is_placeholder_model": not is_own_finetune,
        "detected_real_damage_classes": found_real_damage_class,
        "model_checkpoint": weights_path,
    }
