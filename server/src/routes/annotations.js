// Annotation Studio's backend: upload raw photos, list them for the admin
// to pick from, and save hand-drawn polygon annotations straight into the
// exact `raw_pool/<vehicle_type>/{images,labels}/` layout
// training/scripts/prepare_dataset.py expects -- so "Save Annotation" in
// the UI really does produce a (image, YOLO-label) pair ready for that
// script, with no manual file-copying step in between.
//
// This intentionally lives in the Node API (not yolo-service/) -- it's
// just file storage + bookkeeping, no ML involved.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { settings } from '../config.js';
import { db } from '../db/database.js';
import { TRAINABLE_DAMAGE_TYPES, VEHICLE_TYPES } from '../schemas/constants.js';
import { annotationSaveSchema, annotationUploadFormSchema } from '../schemas/validation.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = Router();

const RAW_POOL_ROOT = path.resolve(process.cwd(), settings.trainingRawPoolDir);

function imagesDir(vehicleType) {
    return path.join(RAW_POOL_ROOT, vehicleType, 'images');
}
function labelsDir(vehicleType) {
    return path.join(RAW_POOL_ROOT, vehicleType, 'labels');
}

function extensionFor(mimetype) {
    if (mimetype === 'image/png') return '.png';
    if (mimetype === 'image/webp') return '.webp';
    return '.jpg';
}

const insertPhoto = db.prepare(`
    INSERT INTO annotation_photos (id, vehicle_type, original_filename, stored_filename)
    VALUES (@id, @vehicle_type, @original_filename, @stored_filename)
`);
const getPhoto = db.prepare('SELECT * FROM annotation_photos WHERE id = ?');
const listPhotos = db.prepare('SELECT * FROM annotation_photos WHERE vehicle_type = ? ORDER BY created_at DESC');
const markAnnotated = db.prepare(`
    UPDATE annotation_photos
    SET annotated = 1, annotations_json = @annotations_json,
        image_width = @image_width, image_height = @image_height,
        annotated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = @id
`);
const deletePhotoRow = db.prepare('DELETE FROM annotation_photos WHERE id = ?');

function rowToPhotoOut(row) {
    return {
        id: row.id,
        vehicle_type: row.vehicle_type,
        original_filename: row.original_filename,
        file_url: `/api/v1/annotations/photos/${row.id}/file`,
        image_width: row.image_width,
        image_height: row.image_height,
        annotated: !!row.annotated,
        annotations: row.annotations_json ? JSON.parse(row.annotations_json) : null,
        created_at: row.created_at,
        annotated_at: row.annotated_at,
    };
}

// POST /api/v1/annotations/upload -- multiple photos + vehicle_type,
// multipart/form-data. Saves each straight into the raw pool's images/
// folder and indexes it in the DB; no label yet (annotated = 0).
router.post('/api/v1/annotations/upload', upload.array('photos', 50), (req, res) => {
    const parsed = annotationUploadFormSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ detail: parsed.error.issues });
    }
    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ detail: 'No photos were uploaded.' });
    }

    const { vehicle_type: vehicleType } = parsed.data;
    fs.mkdirSync(imagesDir(vehicleType), { recursive: true });
    fs.mkdirSync(labelsDir(vehicleType), { recursive: true });

    const saved = [];
    for (const file of req.files) {
        if (!file.buffer || file.buffer.length === 0) continue;
        const id = randomUUID();
        const storedFilename = `${id}${extensionFor(file.mimetype)}`;
        fs.writeFileSync(path.join(imagesDir(vehicleType), storedFilename), file.buffer);
        insertPhoto.run({
            id,
            vehicle_type: vehicleType,
            original_filename: file.originalname || storedFilename,
            stored_filename: storedFilename,
        });
        saved.push(rowToPhotoOut(getPhoto.get(id)));
    }

    return res.json({ uploaded: saved.length, photos: saved });
});

// GET /api/v1/annotations/photos?vehicle_type=car -- list photos for the
// thumbnail grid, newest first. Includes already-annotated ones too (with
// their saved polygons) so re-opening a photo pre-loads its annotations.
router.get('/api/v1/annotations/photos', (req, res) => {
    const vehicleType = req.query.vehicle_type;
    if (!VEHICLE_TYPES.includes(vehicleType)) {
        return res.status(422).json({ detail: `vehicle_type must be one of ${VEHICLE_TYPES.join(', ')}` });
    }
    const rows = listPhotos.all(vehicleType);
    return res.json({ photos: rows.map(rowToPhotoOut) });
});

// GET /api/v1/annotations/photos/:id/file -- serves the raw image bytes so
// the frontend can display it (<img src=".../file">) without needing a
// separate static-file mount.
router.get('/api/v1/annotations/photos/:id/file', (req, res) => {
    const row = getPhoto.get(req.params.id);
    if (!row) return res.status(404).json({ detail: 'Photo not found.' });
    const filePath = path.join(imagesDir(row.vehicle_type), row.stored_filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ detail: 'Photo file missing on disk.' });
    return res.sendFile(filePath);
});

// POST /api/v1/annotations/photos/:id/save -- body: { image_width,
// image_height, polygons: [{ part, damage_type, points: [[x,y],...] }] }
// (points in original image pixel coordinates). Writes the YOLO
// segmentation label straight into the raw pool's labels/ folder, same
// basename as the image -- exactly what prepare_dataset.py expects.
router.post('/api/v1/annotations/photos/:id/save', (req, res) => {
    const row = getPhoto.get(req.params.id);
    if (!row) return res.status(404).json({ detail: 'Photo not found.' });

    const parsed = annotationSaveSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ detail: parsed.error.issues });
    }
    const { image_width: width, image_height: height, polygons } = parsed.data;

    const labelText = polygons
        .map((poly) => {
            const classId = TRAINABLE_DAMAGE_TYPES.indexOf(poly.damage_type);
            const coords = poly.points.map(([x, y]) => `${(x / width).toFixed(6)} ${(y / height).toFixed(6)}`).join(' ');
            return `${classId} ${coords}`;
        })
        .join('\n');

    const labelStem = path.parse(row.stored_filename).name; // same stem as the image, different extension
    fs.mkdirSync(labelsDir(row.vehicle_type), { recursive: true });
    fs.writeFileSync(path.join(labelsDir(row.vehicle_type), `${labelStem}.txt`), labelText);

    markAnnotated.run({
        id: row.id,
        annotations_json: JSON.stringify(polygons),
        image_width: width,
        image_height: height,
    });

    return res.json(rowToPhotoOut(getPhoto.get(row.id)));
});

// DELETE /api/v1/annotations/photos/:id -- removes the photo, its label
// (if any), and the DB row. For cleaning up test uploads / mistakes.
router.delete('/api/v1/annotations/photos/:id', (req, res) => {
    const row = getPhoto.get(req.params.id);
    if (!row) return res.status(404).json({ detail: 'Photo not found.' });

    const imagePath = path.join(imagesDir(row.vehicle_type), row.stored_filename);
    const labelStem = path.parse(row.stored_filename).name;
    const labelPath = path.join(labelsDir(row.vehicle_type), `${labelStem}.txt`);
    fs.rmSync(imagePath, { force: true });
    fs.rmSync(labelPath, { force: true });
    deletePhotoRow.run(row.id);

    return res.json({ deleted: true, id: row.id });
});

export default router;
