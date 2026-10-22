# Annotating in Label Studio (the recommended annotation tool)

The in-app **Offline Training** screen has a built-in polygon editor, which is
fine for a handful of photos and for fixing one bad label. For annotating a
real dataset (hundreds to thousands of photos, several annotators, review
passes), use a purpose-built annotation tool instead and import its export
here.

This folder sets up **Label Studio** — open source, runs fully offline on your
own machine, no Docker needed. (CVAT is the other strong option and is equally
supported by the importer, but it only runs under Docker. Roboflow is cloud —
your claim photos would leave the building, so it does not fit the offline
requirement.)

## 1. Start Label Studio

Already installed in `ai-damage-assessment-service/ai-training-backend/.venv-labelstudio`:

```powershell
cd ai-damage-assessment-service/ai-training-backend
$env:LABEL_STUDIO_BASE_DATA_DIR = "$PWD\.labelstudio-data"   # keeps its DB inside this repo
.\.venv-labelstudio\Scripts\python.exe -m label_studio.server start --no-browser --port 8081
```

(Linux/macOS: `LABEL_STUDIO_BASE_DATA_DIR=$PWD/.labelstudio-data
.venv-labelstudio/bin/python -m label_studio.server start --port 8081`.)

Port 8081 keeps it clear of this project's own services (8000 API, 8001 YOLO).
Open <http://localhost:8081>, create a local account the first time — it's
stored in `.labelstudio-data/`, nothing leaves your machine. First start takes
a minute or so while it initializes its database.

## 2. Create the project

1. **Create Project** → name it e.g. `Car damage — car`.
2. **Data Import** → drag in your photos (or point it at a local folder).
3. **Labeling Setup → Custom template → Code** → paste the contents of
   [`damage-polygon-config.xml`](damage-polygon-config.xml) and save.

Keep one project per vehicle type (car / two_wheeler / commercial_vehicle) —
the import step below is per vehicle type.

## 3. Annotate

For every damaged area: pick the damage type, then click around its outline to
close a polygon. Use polygons, not boxes — training fine-tunes a segmentation
model and learns the damage shape.

The 6 damage types are fixed: `crack`, `dent`, `glass_shatter`, `lamp_broken`,
`scratch`, `tire_flat`. A label under any other name is reported and skipped at
import rather than being guessed at.

## 4. Export

**Export → COCO** (not "YOLO" — Label Studio's YOLO export writes boxes and
drops your polygons). You get a `.zip`.

## 5. Import into training

Either from the web app — **Offline Training → "⇪ Import Annotated Export
(.zip)"**, pick the vehicle type first — or from the command line:

```bash
cd ai-damage-assessment-service/ai-training-backend/training
../.venv-training/Scripts/python.exe scripts/import_annotation_export.py \
    --source /path/to/export.zip --vehicle-type car --dry-run
```

`--dry-run` reports what would be imported without writing anything — worth
doing once to confirm your class names map cleanly. Drop the flag to import
for real: images and converted YOLO-segmentation labels land in
`training/raw_pool/<vehicle_type>/`, exactly where `prepare_dataset.py` and
`train.py` look for them.

Then click **Start Training** in the same screen (or run the two scripts by
hand, see [`../README.md`](../README.md)).

## Importing from CVAT or Roboflow instead

The same importer handles them — no extra steps:

- **CVAT** → export as *COCO 1.0* (polygons) or *Ultralytics YOLO Segmentation*.
- **Roboflow** → export as *YOLOv8* (with segmentation masks enabled).

The importer auto-detects which of the two shapes it was handed, and maps
common class-name spellings (`Dent`, `flat tyre`, `broken glass`, …) onto the
6 damage types.
