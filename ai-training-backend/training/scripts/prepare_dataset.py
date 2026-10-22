"""Splits a raw pool of annotated (image, YOLO-label) pairs into
train/val/test, stratified by vehicle type AND damage type — Section 2.1 of
docs/ARCHITECTURE.md ("stratified by vehicle type and damage type so rare
damage types aren't underrepresented in test data").

Input layout expected (e.g. everything Annotation Studio has exported so
far, or your CVAT/Labelbox export converted to YOLO format already):

    raw_pool/
      car/
        images/*.png|jpg
        labels/*.txt         (same basename as the matching image)
      two_wheeler/
        images/... labels/...
      commercial_vehicle/
        images/... labels/...

Output: populates training/data/<vehicle_type>/{images,labels}/{train,val,test}/
and (re)writes that vehicle type's data.yaml.

Usage:
    python prepare_dataset.py --raw-pool ./raw_pool --vehicle-type car \
        --train 0.8 --val 0.1 --test 0.1
"""

from __future__ import annotations

import argparse
import random
import shutil
from collections import defaultdict
from pathlib import Path

import yaml

# CarDD's 6 classes (Wang et al.) -- matches yolo-service/app.py's default
# checkpoint's own class order, since fine-tuning starts *from* that
# checkpoint. Must stay in sync with server/src/schemas/constants.js's
# TRAINABLE_DAMAGE_TYPES and training/data/<vehicle_type>/data.yaml.
DAMAGE_TYPE_NAMES = ["crack", "dent", "glass_shatter", "lamp_broken", "scratch", "tire_flat"]

SCRIPT_DIR = Path(__file__).parent
TRAINING_ROOT = SCRIPT_DIR.parent


def _primary_damage_class(label_path: Path) -> int:
    """The stratification key for one image: its most severe/first-listed
    damage class id, so rare classes (e.g. 'shatter') get spread across
    train/val/test in roughly the same proportion as they appear overall,
    rather than by chance ending up entirely in one split.
    """
    if not label_path.exists() or label_path.stat().st_size == 0:
        return -1  # no annotations — treated as its own stratum
    first_line = label_path.read_text().strip().splitlines()[0]
    return int(first_line.split()[0])


def _split_group(items: list[Path], train: float, val: float, seed: int) -> dict[str, list[Path]]:
    rng = random.Random(seed)
    shuffled = items[:]
    rng.shuffle(shuffled)
    n = len(shuffled)
    n_train = round(n * train)
    n_val = round(n * val)
    return {
        "train": shuffled[:n_train],
        "val": shuffled[n_train : n_train + n_val],
        "test": shuffled[n_train + n_val :],
    }


def prepare(raw_pool: Path, vehicle_type: str, train: float, val: float, test: float, seed: int) -> None:
    assert abs(train + val + test - 1.0) < 1e-6, "train+val+test must sum to 1.0"

    images_dir = raw_pool / vehicle_type / "images"
    labels_dir = raw_pool / vehicle_type / "labels"
    if not images_dir.exists():
        raise SystemExit(f"No raw pool found at {images_dir}")

    # Group images by their primary damage class (the stratification key).
    by_class: dict[int, list[Path]] = defaultdict(list)
    for image_path in sorted(images_dir.glob("*")):
        if image_path.suffix.lower() not in {".png", ".jpg", ".jpeg"}:
            continue
        label_path = labels_dir / f"{image_path.stem}.txt"
        by_class[_primary_damage_class(label_path)].append(image_path)

    out_root = TRAINING_ROOT / "data" / vehicle_type
    for split in ("train", "val", "test"):
        (out_root / "images" / split).mkdir(parents=True, exist_ok=True)
        (out_root / "labels" / split).mkdir(parents=True, exist_ok=True)

    counts = {"train": 0, "val": 0, "test": 0}
    for class_id, images in by_class.items():
        splits = _split_group(images, train, val, seed)
        for split, split_images in splits.items():
            for image_path in split_images:
                label_path = labels_dir / f"{image_path.stem}.txt"
                shutil.copy2(image_path, out_root / "images" / split / image_path.name)
                dest_label = out_root / "labels" / split / f"{image_path.stem}.txt"
                if label_path.exists():
                    shutil.copy2(label_path, dest_label)
                else:
                    dest_label.write_text("")  # background/no-damage image
            counts[split] += len(split_images)
        class_name = DAMAGE_TYPE_NAMES[class_id] if 0 <= class_id < len(DAMAGE_TYPE_NAMES) else "no_damage"
        print(f"  class '{class_name}': {len(images)} images -> "
              f"train={len(splits['train'])} val={len(splits['val'])} test={len(splits['test'])}")

    data_yaml_path = out_root / "data.yaml"
    data_yaml_path.write_text(
        yaml.safe_dump(
            {
                "path": ".",
                "train": "images/train",
                "val": "images/val",
                "names": dict(enumerate(DAMAGE_TYPE_NAMES)),
            },
            sort_keys=False,
        )
    )

    print(f"\nDone. {vehicle_type}: train={counts['train']} val={counts['val']} test={counts['test']}")
    print(f"data.yaml written to {data_yaml_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--raw-pool", type=Path, required=True)
    parser.add_argument("--vehicle-type", choices=["car", "two_wheeler", "commercial_vehicle"], required=True)
    parser.add_argument("--train", type=float, default=0.8)
    parser.add_argument("--val", type=float, default=0.1)
    parser.add_argument("--test", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    prepare(args.raw_pool, args.vehicle_type, args.train, args.val, args.test, args.seed)
