"""Turns handler corrections logged via POST /api/v1/corrections into new
YOLOv8 training samples — this is what makes docs/ARCHITECTURE.md Section 5
("every claim your team processes after go-live is additional, real,
correctly-labelled training data") actually happen, rather than just being
a queue that sits there.

For each unconsumed Correction row:
  1. Find the original photo (saved by routes_detect.py under UPLOAD_DIR,
     keyed by photo_id).
  2. Convert `corrected_output.detections` into a YOLO segmentation label
     (same format Annotation Studio exports).
  3. Copy the image + write the label straight into that vehicle type's
     images/train + labels/train (so the next train.py run picks it up).
  4. Mark the row `consumed_by_retraining_run` so it isn't exported twice.

Run this on the same schedule as your fine-tune trigger (Section 5:
"monthly OR every 5,000 new corrected samples, whichever comes first" —
GET /api/v1/corrections/stats tells you which condition is closer).

Usage:
    python export_corrections_for_retraining.py --run-id 2026-08-01
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
TRAINING_ROOT = SCRIPT_DIR.parent
SERVICE_ROOT = TRAINING_ROOT.parent

# The corrections table now lives in the Node service's plain SQLite file
# (server/src/db/database.js -- node:sqlite, no ORM), not a Python app/ any
# more. Python's stdlib sqlite3 reads that same file directly -- no need to
# go through the Node API or duplicate its schema; DATABASE_FILE/UPLOAD_DIR
# below match server/.env's defaults, override via env vars if you changed
# either there.
DB_FILE = Path(os.environ.get("SERVER_DATABASE_FILE", SERVICE_ROOT / "server" / "ai_damage_assessment.db"))
UPLOAD_DIR = Path(os.environ.get("SERVER_UPLOAD_DIR", SERVICE_ROOT / "server" / "uploads"))

DAMAGE_TYPE_NAMES = ["dent", "scratch", "crack", "shatter", "deformation", "tear"]


def _find_uploaded_photo(photo_id: str) -> Path | None:
    for ext in (".jpg", ".png", ".webp"):
        candidate = UPLOAD_DIR / f"{photo_id}{ext}"
        if candidate.exists():
            return candidate
    return None


def _detections_to_yolo_label(detections: list[dict]) -> str:
    lines = []
    for detection in detections:
        damage_type = detection.get("damage_type", "unknown")
        if damage_type not in DAMAGE_TYPE_NAMES:
            continue  # 'unknown' (placeholder-model output) isn't trainable
        class_id = DAMAGE_TYPE_NAMES.index(damage_type)
        polygon = detection.get("mask_polygon", [])
        if len(polygon) < 3:
            continue
        coords = " ".join(f"{x:.6f} {y:.6f}" for x, y in polygon)
        lines.append(f"{class_id} {coords}")
    return "\n".join(lines)


def export(run_id: str) -> None:
    if not DB_FILE.exists():
        print(f"No database file at {DB_FILE} -- start the Node API (server/) at least once first.")
        return

    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    exported_per_vehicle_type: dict[str, int] = {}
    skipped_no_photo = 0

    try:
        pending = conn.execute(
            "SELECT * FROM corrections WHERE consumed_by_retraining_run IS NULL"
        ).fetchall()
        print(f"Found {len(pending)} unconsumed corrections.")

        for row in pending:
            photo_path = _find_uploaded_photo(row["photo_id"])
            if photo_path is None:
                print(f"  [skip] correction {row['id']}: no saved photo for photo_id={row['photo_id']}")
                skipped_no_photo += 1
                continue

            # corrected_output is stored as a JSON TEXT column (see
            # server/src/db/database.js) -- decode it, unlike the old
            # SQLAlchemy model which deserialized it automatically.
            corrected_output = json.loads(row["corrected_output"])
            detections = corrected_output.get("detections", [])
            label_text = _detections_to_yolo_label(detections)

            vehicle_type = row["vehicle_type"]
            out_root = TRAINING_ROOT / "data" / vehicle_type
            images_out = out_root / "images" / "train"
            labels_out = out_root / "labels" / "train"
            images_out.mkdir(parents=True, exist_ok=True)
            labels_out.mkdir(parents=True, exist_ok=True)

            dest_image = images_out / f"correction_{row['id']}{photo_path.suffix}"
            dest_label = labels_out / f"correction_{row['id']}.txt"
            shutil.copy2(photo_path, dest_image)
            dest_label.write_text(label_text)

            conn.execute(
                "UPDATE corrections SET consumed_by_retraining_run = ? WHERE id = ?",
                (run_id, row["id"]),
            )
            exported_per_vehicle_type[vehicle_type] = exported_per_vehicle_type.get(vehicle_type, 0) + 1

        conn.commit()
    finally:
        conn.close()

    print(f"\nExported into training/data/<vehicle_type>/images|labels/train, run_id={run_id}:")
    for vehicle_type, count in exported_per_vehicle_type.items():
        print(f"  {vehicle_type}: {count} new samples")
    if skipped_no_photo:
        print(f"  skipped (no saved photo found): {skipped_no_photo}")
    print(
        "\nNext step: python train.py --vehicle-type <type> "
        "--base runs/segment/<type>_finetune/weights/best.pt   (continual fine-tune, not from scratch)"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--run-id",
        default=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H%M%SZ"),
        help="Tag applied to every correction consumed in this run (defaults to a UTC timestamp).",
    )
    args = parser.parse_args()
    export(args.run_id)
