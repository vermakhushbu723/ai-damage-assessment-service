// POST /api/v1/detect -- accepts a photo + vehicle_type, persists the
// original photo (so a later handler correction has an actual image to
// pair with the corrected label -- see training/scripts/export_corrections_
// for_retraining.py), then forwards the photo to the YOLO inference
// microservice (../../yolo-service) and returns its detections plus the
// photo_id generated here.
//
// This Node service never loads YOLO itself -- see docs/ARCHITECTURE.md
// Section 8 for why that one piece has to stay in Python.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { settings } from '../config.js';
import { detectFormSchema } from '../schemas/validation.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = Router();

function extensionFor(contentType) {
    if (contentType === 'image/png') return '.png';
    if (contentType === 'image/webp') return '.webp';
    return '.jpg';
}

function persistUpload(photoId, buffer, contentType) {
    fs.mkdirSync(settings.uploadDir, { recursive: true });
    const filePath = path.join(settings.uploadDir, `${photoId}${extensionFor(contentType)}`);
    fs.writeFileSync(filePath, buffer);
}

router.post('/api/v1/detect', upload.single('photo'), async (req, res) => {
    const parsed = detectFormSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ detail: parsed.error.issues });
    }
    if (!req.file || req.file.buffer.length === 0) {
        return res.status(400).json({ detail: 'Uploaded photo is empty.' });
    }

    const { vehicle_type: vehicleType } = parsed.data;
    const photoId = randomUUID();
    persistUpload(photoId, req.file.buffer, req.file.mimetype);

    try {
        const form = new FormData();
        form.append('vehicle_type', vehicleType);
        form.append('photo', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname || 'photo.jpg');

        const yoloResponse = await fetch(`${settings.yoloServiceUrl}/detect`, { method: 'POST', body: form });

        if (!yoloResponse.ok) {
            const detail = await yoloResponse.text();
            return res.status(503).json({
                detail: `YOLO inference service returned an error (${yoloResponse.status}): ${detail}`,
            });
        }

        const { detections, is_placeholder_model, detected_real_damage_classes, model_checkpoint } = await yoloResponse.json();

        return res.json({
            photo_id: photoId,
            vehicle_type: vehicleType,
            detections,
            is_placeholder_model,
            detected_real_damage_classes,
            model_checkpoint,
        });
    } catch (err) {
        return res.status(503).json({
            detail: `Could not reach the YOLO inference service at ${settings.yoloServiceUrl}: ${err.message}. ` +
                    'Is ../yolo-service running? See its README.',
        });
    }
});

export default router;
