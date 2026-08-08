// Zod request-body schemas -- the JS equivalent of the Pydantic models in
// the old Python service's app/schemas.py. Only request shapes are
// validated here; response shapes are just plain objects built by the
// route handlers (no separate "response model" layer, unlike FastAPI).

import { z } from 'zod';
import { DAMAGE_TYPES, TRAINABLE_DAMAGE_TYPES, VEHICLE_TYPES } from './constants.js';

export const detectionSchema = z.object({
    part: z.string(),
    damage_type: z.enum(DAMAGE_TYPES),
    mask_polygon: z.array(z.array(z.number())),
    confidence: z.number(),
    mask_area_ratio: z.number(),
});

export const vehicleInfoSchema = z.object({
    make: z.string(),
    model: z.string(),
    year: z.number(),
    region: z.string().default('default'),
});

export const assessRequestSchema = z.object({
    vehicle: vehicleInfoSchema,
    detections: z.array(detectionSchema),
    photo_id: z.string().nullish(),
});

export const causeCheckRequestSchema = z.object({
    reported_cause: z.string(),
    detections: z.array(detectionSchema),
});

export const assessmentLineItemSchema = z.object({
    part: z.string(),
    damage_type: z.enum(DAMAGE_TYPES),
    severity: z.string(),
    action: z.string(),
    part_cost: z.number(),
    labor_cost: z.number(),
    paint_consumables_cost: z.number(),
    line_total: z.number(),
    rate_source: z.string(),
});

export const assessmentResultSchema = z.object({
    photo_id: z.string().nullish(),
    vehicle: vehicleInfoSchema,
    line_items: z.array(assessmentLineItemSchema),
    total_cost: z.number(),
});

export const reportRequestSchema = z.object({
    claim_id: z.string(),
    vehicle: vehicleInfoSchema,
    reported_cause: z.string(),
    detections: z.array(detectionSchema),
    assessment: assessmentResultSchema,
});

export const correctionCreateSchema = z.object({
    claim_id: z.string(),
    photo_id: z.string(),
    vehicle_type: z.enum(VEHICLE_TYPES),
    ai_output: z.record(z.any()),
    corrected_output: z.record(z.any()),
    reviewer_id: z.string(),
    reason: z.string().nullish(),
});

export const detectFormSchema = z.object({
    vehicle_type: z.enum(VEHICLE_TYPES),
});

export const annotationUploadFormSchema = z.object({
    vehicle_type: z.enum(VEHICLE_TYPES),
});

export const annotationPolygonSchema = z.object({
    part: z.string().min(1),
    damage_type: z.enum(TRAINABLE_DAMAGE_TYPES),
    // [[x,y], [x,y], ...] in ORIGINAL image pixel coordinates -- the route
    // normalizes to 0-1 using image_width/image_height below, matching the
    // YOLO segmentation label format (see routes/annotations.js).
    points: z.array(z.tuple([z.number(), z.number()])).min(3),
});

export const annotationSaveSchema = z.object({
    image_width: z.number().positive(),
    image_height: z.number().positive(),
    polygons: z.array(annotationPolygonSchema),
});
