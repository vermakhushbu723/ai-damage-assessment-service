"""Imports an annotation export from an external labeling tool (Label Studio,
CVAT, Roboflow, ...) into `training/raw_pool/<vehicle_type>/{images,labels}/`
-- the exact layout prepare_dataset.py expects.

This is the "annotate in a real tool, train here" path: you do the labeling in
Label Studio/CVAT (polygons, keyboard shortcuts, multiple annotators, review
queues -- everything the in-app Annotation Studio doesn't do), export, and
point this script at the export. The web UI's "Import Annotated Export"
button calls this same script, so nothing has to be copied by hand.

Two export shapes are understood, auto-detected:

  1. COCO instance segmentation (Label Studio's "COCO" export, CVAT's
     "COCO 1.0") -- a result.json/instances_*.json with `segmentation`
     polygons, plus the image files.
  2. YOLO segmentation (CVAT's "Ultralytics YOLO Segmentation", Roboflow's
     "YOLOv8" export) -- images/ + labels/*.txt already in YOLO format,
     with a data.yaml / obj.names listing the class order used.

In both cases class names are mapped onto this project's 6 CarDD damage
types; anything unrecognized is reported and skipped rather than silently
imported under the wrong class id.

Usage:
    python import_annotation_export.py --source <export.zip|folder> \
        --vehicle-type car [--raw-pool ../raw_pool] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
import zipfile
from collections import Counter
from pathlib import Path

# Must stay in sync with prepare_dataset.py's DAMAGE_TYPE_NAMES and
# server/src/schemas/constants.js's TRAINABLE_DAMAGE_TYPES -- index IS the
# YOLO class id.
DAMAGE_TYPE_NAMES = ["crack", "dent", "glass_shatter", "lamp_broken", "scratch", "tire_flat"]

# Names other tools/templates commonly use for the same 6 classes. Keys are
# normalized (lowercase, non-alphanumerics collapsed to "_").
ALIASES = {
    "crack": "crack", "cracked": "crack", "structural_crack": "crack",
    "dent": "dent", "dents": "dent", "dented": "dent", "deep_dent": "dent",
    "glass_shatter": "glass_shatter", "shatter": "glass_shatter", "glass": "glass_shatter",
    "glass_broken": "glass_shatter", "broken_glass": "glass_shatter", "windshield_damage": "glass_shatter",
    "lamp_broken": "lamp_broken", "lamp": "lamp_broken", "broken_lamp": "lamp_broken",
    "headlight_broken": "lamp_broken", "light_broken": "lamp_broken", "broken_light": "lamp_broken",
    "scratch": "scratch", "scratches": "scratch", "scratched": "scratch", "paint_damage": "scratch",
    "tire_flat": "tire_flat", "flat_tire": "tire_flat", "tyre_flat": "tire_flat",
    "flat_tyre": "tire_flat", "tire": "tire_flat", "tyre": "tire_flat",
}

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def normalize(name: str) -> str:
    out = "".join(ch if ch.isalnum() else "_" for ch in name.strip().lower())
    while "__" in out:
        out = out.replace("__", "_")
    return out.strip("_")


def class_id_for(name: str) -> int | None:
    canonical = ALIASES.get(normalize(name))
    return DAMAGE_TYPE_NAMES.index(canonical) if canonical else None


def find_images(root: Path) -> dict[str, Path]:
    """Every image in the export, keyed by file name (tools nest them under
    images/, data/, obj_train_data/, ... so search the whole tree)."""
    found: dict[str, Path] = {}
    for path in root.rglob("*"):
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES:
            found.setdefault(path.name, path)
    return found


def polygon_to_yolo(points: list[float], width: int, height: int) -> list[str]:
    """COCO segmentation ([x1,y1,x2,y2,...] in pixels) -> normalized YOLO-seg
    coordinates, clamped to the image so a slightly out-of-bounds polygon
    doesn't produce an invalid label."""
    coords = []
    for i in range(0, len(points) - 1, 2):
        x = min(max(points[i] / width, 0.0), 1.0)
        y = min(max(points[i + 1] / height, 0.0), 1.0)
        coords += [f"{x:.6f}", f"{y:.6f}"]
    return coords


def import_coco(coco_path: Path, root: Path) -> tuple[dict[str, list[str]], Counter, Counter]:
    """Returns {image file name: [yolo label lines]}, per-class counts, skipped-class counts."""
    data = json.loads(coco_path.read_text(encoding="utf-8"))
    categories = {c["id"]: c["name"] for c in data.get("categories", [])}
    images = {img["id"]: img for img in data.get("images", [])}
    labels: dict[str, list[str]] = {}
    kept, skipped = Counter(), Counter()

    for ann in data.get("annotations", []):
        image = images.get(ann.get("image_id"))
        if not image:
            continue
        class_name = categories.get(ann.get("category_id"), "")
        class_id = class_id_for(class_name)
        if class_id is None:
            skipped[class_name or "(unnamed)"] += 1
            continue

        segmentation = ann.get("segmentation") or []
        # RLE (dict) masks aren't supported -- export polygons, not masks.
        if isinstance(segmentation, dict) or not segmentation:
            skipped[f"{class_name} (no polygon)"] += 1
            continue

        width, height = image.get("width"), image.get("height")
        if not width or not height:
            skipped[f"{class_name} (image size missing)"] += 1
            continue

        for polygon in segmentation:
            if len(polygon) < 6:  # fewer than 3 points
                continue
            coords = polygon_to_yolo(polygon, width, height)
            name = Path(image["file_name"]).name
            labels.setdefault(name, []).append(f"{class_id} " + " ".join(coords))
            kept[DAMAGE_TYPE_NAMES[class_id]] += 1

    # Images the annotator reviewed but marked as undamaged still belong in
    # the dataset as negatives -- an empty label file is a valid YOLO label.
    for image in images.values():
        labels.setdefault(Path(image["file_name"]).name, [])

    return labels, kept, skipped


def read_class_order(root: Path) -> list[str] | None:
    """Class order the YOLO-format export was written with (data.yaml's
    `names:`, or obj.names / classes.txt, one per line)."""
    for yaml_path in sorted(root.rglob("*.yaml")) + sorted(root.rglob("*.yml")):
        text = yaml_path.read_text(encoding="utf-8", errors="ignore")
        if "names:" not in text:
            continue
        try:
            import yaml as pyyaml
            names = pyyaml.safe_load(text).get("names")
        except Exception:
            continue
        if isinstance(names, dict):
            return [names[key] for key in sorted(names)]
        if isinstance(names, list):
            return names
    for names_file in ("obj.names", "classes.txt", "labels.txt"):
        for path in root.rglob(names_file):
            return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return None


def import_yolo(root: Path) -> tuple[dict[str, list[str]], Counter, Counter]:
    """Re-maps an existing YOLO-format export onto this project's class ids."""
    order = read_class_order(root)
    labels: dict[str, list[str]] = {}
    kept, skipped = Counter(), Counter()
    images = find_images(root)

    for label_path in root.rglob("*.txt"):
        if label_path.name in {"obj.names", "classes.txt", "labels.txt"}:
            continue
        image_name = next((n for n in images if Path(n).stem == label_path.stem), None)
        if not image_name:
            continue
        lines = []
        for line in label_path.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if len(parts) < 7:  # class + at least 3 points
                continue
            source_name = order[int(parts[0])] if order and int(parts[0]) < len(order) else parts[0]
            class_id = class_id_for(str(source_name))
            if class_id is None:
                skipped[str(source_name)] += 1
                continue
            lines.append(" ".join([str(class_id), *parts[1:]]))
            kept[DAMAGE_TYPE_NAMES[class_id]] += 1
        labels[image_name] = lines

    return labels, kept, skipped


def run(source: Path, vehicle_type: str, raw_pool: Path, dry_run: bool) -> dict:
    temp_dir = None
    try:
        if source.is_file() and source.suffix.lower() == ".zip":
            temp_dir = Path(tempfile.mkdtemp(prefix="annotation-import-"))
            with zipfile.ZipFile(source) as archive:
                archive.extractall(temp_dir)
            root = temp_dir
        else:
            root = source

        coco_files = [
            p for p in root.rglob("*.json")
            if "annotations" in p.read_text(encoding="utf-8", errors="ignore")[:4000]
        ]
        if coco_files:
            labels, kept, skipped = import_coco(coco_files[0], root)
            export_format = f"COCO ({coco_files[0].name})"
        else:
            labels, kept, skipped = import_yolo(root)
            export_format = "YOLO"

        images = find_images(root)
        images_out = raw_pool / vehicle_type / "images"
        labels_out = raw_pool / vehicle_type / "labels"
        imported, missing = 0, []

        for image_name, lines in labels.items():
            image_path = images.get(image_name)
            if not image_path:
                missing.append(image_name)
                continue
            if not dry_run:
                images_out.mkdir(parents=True, exist_ok=True)
                labels_out.mkdir(parents=True, exist_ok=True)
                shutil.copy2(image_path, images_out / image_name)
                (labels_out / f"{Path(image_name).stem}.txt").write_text("\n".join(lines), encoding="utf-8")
            imported += 1

        return {
            "export_format": export_format,
            "vehicle_type": vehicle_type,
            "images_imported": imported,
            "annotations_imported": sum(kept.values()),
            "per_class": dict(kept),
            "skipped_classes": dict(skipped),
            "images_missing_from_export": missing[:20],
            "dry_run": dry_run,
        }
    finally:
        if temp_dir:
            shutil.rmtree(temp_dir, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", required=True, help="Export .zip or an already-extracted folder.")
    parser.add_argument("--vehicle-type", choices=["car", "two_wheeler", "commercial_vehicle"], required=True)
    parser.add_argument("--raw-pool", default=str(Path(__file__).parent.parent / "raw_pool"))
    parser.add_argument("--dry-run", action="store_true", help="Report what would be imported, write nothing.")
    args = parser.parse_args()

    summary = run(Path(args.source), args.vehicle_type, Path(args.raw_pool), args.dry_run)
    print(json.dumps(summary, indent=2))
    if summary["skipped_classes"]:
        print("\nSome classes were skipped -- rename them in the labeling tool to one of:")
        print("  " + ", ".join(DAMAGE_TYPE_NAMES))


if __name__ == "__main__":
    main()
