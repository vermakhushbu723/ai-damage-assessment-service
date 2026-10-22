import { Router } from 'express';
import { assessDamage } from '../models/costEngine.js';
import { assessRequestSchema } from '../schemas/validation.js';

const router = Router();

router.post('/api/v1/assess', (req, res) => {
    const parsed = assessRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ detail: parsed.error.issues });
    }
    const { vehicle, detections, photo_id: photoId } = parsed.data;
    const result = assessDamage({ vehicle, detections, photoId: photoId ?? null });
    return res.json(result);
});

export default router;
