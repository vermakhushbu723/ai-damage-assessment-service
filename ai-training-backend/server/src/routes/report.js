import { Router } from 'express';
import { checkCauseConsistency } from '../models/causeCheck.js';
import { generateReport } from '../models/llmReport.js';
import { causeCheckRequestSchema, reportRequestSchema } from '../schemas/validation.js';

const router = Router();

router.post('/api/v1/cause-check', (req, res) => {
    const parsed = causeCheckRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ detail: parsed.error.issues });
    }
    const { reported_cause: reportedCause, detections } = parsed.data;
    return res.json(checkCauseConsistency(reportedCause, detections));
});

router.post('/api/v1/report', async (req, res) => {
    const parsed = reportRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(422).json({ detail: parsed.error.issues });
    }
    const payload = parsed.data;
    const causeResult = checkCauseConsistency(payload.reported_cause, payload.detections);
    const { narrative, generatedBy } = await generateReport(payload, causeResult);

    return res.json({
        claim_id: payload.claim_id,
        narrative,
        cause_check: causeResult,
        generated_by: generatedBy,
    });
});

export default router;
