import express from 'express';
import { badRequest, HttpError } from '../utils/http.js';
import { settings } from '../config.js';

// Documents DMS uploads from the admin panel (raw body, like the field app):
// JPG / PNG / WEBP images and PDFs, up to MAX_PHOTO_MB.

export const DMS_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

/** Body parser for one file as the raw request body. */
export const DMS_RAW_BODY = express.raw({ type: () => true, limit: `${settings.maxPhotoMb}mb` });

/** -> { mime, bytes, originalName } or a 400 with a readable reason. */
export function readDmsUpload(req) {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!DMS_MIMES.includes(mime)) throw badRequest('Only JPG, PNG, WEBP or PDF files can be uploaded.');
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) throw badRequest('The file is empty.');
    if (bytes.length > settings.maxPhotoMb * 1024 * 1024) throw new HttpError(413, `File is larger than ${settings.maxPhotoMb} MB.`);
    let originalName = 'document';
    try {
        originalName = decodeURIComponent(String(req.headers['x-file-name'] || '')).trim() || originalName;
    } catch {
        /* keep the default */
    }
    return { mime, bytes, originalName: originalName.replace(/[\\/\r\n]/g, '_').slice(0, 120) };
}
