"""Minimal YOLOv8-seg inference microservice.

Uses YOLOv8-seg rather than the newer YOLO11-seg -- same `ultralytics`
package/API either way (just a different checkpoint name), chosen for
YOLOv8's maturity/stability and CPU-friendliness on this project's
offline/on-prem deployment target (better docs, huge community, more
predictable CPU training behavior) over YOLO11's marginally newer
architecture. This is a deliberate deviation from the client's original
spec, which named YOLOv11 -- see docs/ARCHITECTURE.md's data schema
section for the reasoning; flag it to the client before going live.

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

# COCO class ids that plausibly represent "a vehicle" -- used only by the
# placeholder path described below.
_COCO_VEHICLE_CLASS_NAMES = {"car", "truck", "bus", "motorcycle", "bicycle"}

_DAMAGE_TYPES = {"dent", "scratch", "crack", "shatter", "deformation", "tear", "unknown"}

_WEIGHTS_BY_VEHICLE_TYPE = {
    "car": os.getenv("YOLO_CAR_WEIGHTS", "yolov8n-seg.pt"),
    "two_wheeler": os.getenv("YOLO_TWO_WHEELER_WEIGHTS", "yolov8n-seg.pt"),
    "commercial_vehicle": os.getenv("YOLO_CV_WEIGHTS", "yolov8n-seg.pt"),
}
_CONF_THRESHOLD = float(os.getenv("YOLO_CONF_THRESHOLD", "0.25"))

_models: dict[str, object] = {}
_lock = Lock()


def _is_placeholder_checkpoint(weights_path: str) -> bool:
    # Stock Ultralytics checkpoint filenames look like "yolov8s-seg.pt" with
    # no directory -- a fine-tuned checkpoint will be a path into your own
    # training output (e.g. "runs/segment/car_v3/weights/best.pt").
    return Path(weights_path).parent == Path(".")


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
        logger.info("Loading YOLOv8 checkpoint for %s: %s", vehicle_type, weights_path)
        try:
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
    is_placeholder = _is_placeholder_checkpoint(weights_path)

    try:
        model = _get_model(vehicle_type)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    results = model.predict(source=image, conf=_CONF_THRESHOLD, verbose=False)
    result = results[0]

    detections: list[dict] = []

    if result.masks is not None:
        class_names = result.names
        polygons = result.masks.xyn  # normalized polygon points per instance
        boxes = result.boxes

        for i, polygon in enumerate(polygons):
            cls_id = int(boxes.cls[i].item())
            confidence = float(boxes.conf[i].item())
            class_name = class_names.get(cls_id, str(cls_id))
            polygon_points = [[float(x), float(y)] for x, y in polygon.tolist()]

            if is_placeholder:
                # Placeholder path (module docstring above): only keep
                # whole-vehicle detections, and report them honestly as
                # "whole_vehicle" / "unknown" rather than pretending we
                # found real damage.
                if class_name not in _COCO_VEHICLE_CLASS_NAMES:
                    continue
                detections.append({
                    "part": "whole_vehicle",
                    "damage_type": "unknown",
                    "mask_polygon": polygon_points,
                    "confidence": confidence,
                    "mask_area_ratio": 1.0,
                })
            else:
                # Real fine-tuned checkpoint path: class_name IS the damage
                # type (the taxonomy this project trains against), and part
                # assignment comes from a separate part-region step (not
                # implemented in this scaffold -- plug your
                # part-segmentation/geometry step in here).
                damage_type = class_name if class_name in _DAMAGE_TYPES else "unknown"
                detections.append({
                    "part": "unassigned",  # TODO: wire in part-region assignment
                    "damage_type": damage_type,
                    "mask_polygon": polygon_points,
                    "confidence": confidence,
                    "mask_area_ratio": _estimate_mask_area_ratio(polygon_points),
                })

    return {
        "detections": detections,
        "is_placeholder_model": is_placeholder,
        "model_checkpoint": weights_path,
    }
