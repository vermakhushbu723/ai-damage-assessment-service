"""Fine-tunes YOLO11-seg for one vehicle type — Section 2.2 of
docs/ARCHITECTURE.md.

First run (no prior fine-tuned checkpoint yet):
    python train.py --vehicle-type car --base yolo11l-seg.pt --epochs 150

Later runs — continual fine-tuning from your last checkpoint on top of
newly corrected data prepared via prepare_dataset.py or
export_corrections_for_retraining.py (Section 5, "fine-tune the existing
model checkpoint, not from scratch"):
    python train.py --vehicle-type car \
        --base runs/segment/car_v2/weights/best.pt --epochs 60

After training, point the API at the new checkpoint via
YOLO_CAR_WEIGHTS / YOLO_TWO_WHEELER_WEIGHTS / YOLO_CV_WEIGHTS in
ai-damage-assessment-service/.env — but only after validating it (see
--validate-only) and running it in shadow mode per the rollout plan in the
original architecture proposal.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import yaml

SCRIPT_DIR = Path(__file__).parent
TRAINING_ROOT = SCRIPT_DIR.parent


def _resolve_data_yaml(vehicle_type: str) -> Path:
    """Loads data/<vehicle_type>/data.yaml and rewrites `path:` to an
    absolute directory before handing it to Ultralytics.

    Gotcha found while smoke-testing: Ultralytics resolves a *relative*
    `path:` (the file says `path: .`) against the process's current working
    directory, not against the yaml file's own directory as the comment in
    that file assumes -- so running `python training/scripts/train.py` from
    a different cwd silently looks for images/labels in the wrong place.
    Rewriting `path` to an absolute directory here sidesteps that
    regardless of where this script is invoked from. We write the resolved
    copy next to the source file (not committed -- see .gitignore) rather
    than editing data.yaml in place, since baking an absolute path into a
    git-tracked file would just break on the next machine.
    """
    src = TRAINING_ROOT / "data" / vehicle_type / "data.yaml"
    if not src.exists():
        raise SystemExit(f"No data.yaml at {src} -- run prepare_dataset.py for '{vehicle_type}' first.")

    config = yaml.safe_load(src.read_text())
    config["path"] = str(src.parent.resolve())
    resolved = src.parent / ".data.resolved.yaml"
    resolved.write_text(yaml.safe_dump(config))
    return resolved


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--vehicle-type", choices=["car", "two_wheeler", "commercial_vehicle"], required=True)
    parser.add_argument("--base", default="yolo11l-seg.pt", help="Base checkpoint: stock or a prior fine-tune's best.pt")
    parser.add_argument("--epochs", type=int, default=150)
    parser.add_argument("--imgsz", type=int, default=1280, help="Higher than the 640 default -- damage regions are often small relative to the whole vehicle.")
    parser.add_argument("--batch", type=int, default=16, help="Lower this (e.g. 2-4) on CPU with a large/big base checkpoint -- see training/README.md's CPU troubleshooting note.")
    parser.add_argument("--patience", type=int, default=25, help="Early-stopping patience.")
    parser.add_argument("--device", default="0", help="'0' for first GPU, 'cpu' for CPU-only (much slower).")
    parser.add_argument("--run-name", default=None, help="Defaults to '<vehicle_type>_<timestamp>'.")
    parser.add_argument("--validate-only", action="store_true", help="Skip training, just validate --base against this vehicle type's data.yaml.")
    args = parser.parse_args()

    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise SystemExit(
            "ultralytics isn't installed in this environment. From ai-damage-assessment-service/: "
            "pip install -r requirements.txt"
        ) from exc

    data_yaml = _resolve_data_yaml(args.vehicle_type)

    model = YOLO(args.base)
    run_name = args.run_name or f"{args.vehicle_type}_finetune"

    if args.validate_only:
        metrics = model.val(data=str(data_yaml), imgsz=args.imgsz)
        print(metrics)
        return

    model.train(
        data=str(data_yaml),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        patience=args.patience,
        device=args.device,
        project=str(TRAINING_ROOT / "runs" / "segment"),
        name=run_name,
    )

    print(
        "\nTraining complete. Per docs/ARCHITECTURE.md Section 5, before promoting this "
        "checkpoint to production:\n"
        f"  1. Validate: python train.py --vehicle-type {args.vehicle_type} "
        f"--base runs/segment/{run_name}/weights/best.pt --validate-only\n"
        "  2. Run it in shadow mode against real incoming claims for a period.\n"
        "  3. Only then point YOLO_CAR_WEIGHTS (or the relevant vehicle-type env var) at it."
    )


if __name__ == "__main__":
    main()
