// Logs one handler correction -- this row IS the retraining queue described
// in docs/ARCHITECTURE.md. Nothing retrains automatically from this call; a
// separate scheduled job reads unconsumed rows here on its own cadence
// (weekly/monthly batch, per the client spec's retraining-loop section).

import { Router } from 'express';
import { db } from '../db/database.js';
import { settings } from '../config.js';
import { correctionCreateSchema } from '../schemas/validation.js';

const router = Router();

const insertCorrection = db.prepare(`
    INSERT INTO corrections (claim_id, photo_id, vehicle_type, ai_output, corrected_output, reviewer_id, reason)
    VALUES (@claim_id, @photo_id, @vehicle_type, @ai_output, @corrected_output, @reviewer_id, @reason)
`);
const getCorrectionById = db.prepare('SELECT * FROM corrections WHERE id = ?');

function rowToCorrectionOut(row) {
    return {
        id: row.id,
        claim_id: row.claim_id,
        photo_id: row.photo_id,
        vehicle_type: row.vehicle_type,
        ai_output: JSON.parse(row.ai_output),
        corrected_output: JSON.parse(row.corrected_output),
        reviewer_id: row.reviewer_id,
        reason: row.reason,
        created_at: row.created_at,
    };
}

router.post('/api/v1/corrections', (req, res) => {
    const parsed = correctionCreateSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ detail: parsed.error.issues });
    }
    const payload = parsed.data;

    const info = insertCorrection.run({
        claim_id: payload.claim_id,
        photo_id: payload.photo_id,
        vehicle_type: payload.vehicle_type,
        ai_output: JSON.stringify(payload.ai_output),
        corrected_output: JSON.stringify(payload.corrected_output),
        reviewer_id: payload.reviewer_id,
        reason: payload.reason ?? null,
    });

    const row = getCorrectionById.get(info.lastInsertRowid);
    return res.json(rowToCorrectionOut(row));
});

router.get('/api/v1/corrections/stats', (_req, res) => {
    const pendingCount = db.prepare(
        'SELECT COUNT(*) AS count FROM corrections WHERE consumed_by_retraining_run IS NULL'
    ).get().count;

    const oldest = db.prepare(
        'SELECT created_at FROM corrections WHERE consumed_by_retraining_run IS NULL ORDER BY created_at ASC LIMIT 1'
    ).get();

    return res.json({
        pending_corrections: pendingCount,
        oldest_pending_at: oldest ? oldest.created_at : null,
        volume_threshold: settings.retrainVolumeThreshold,
        threshold_reached: pendingCount >= settings.retrainVolumeThreshold,
    });
});

export default router;
