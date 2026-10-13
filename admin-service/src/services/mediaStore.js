import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { settings } from '../config.js';

// Pre-inspection files on disk: UPLOADS_DIR/<inspection id>/<kind>-<slot>-<random>.<ext>.
// Links handed to the admin panel / app are signed (HMAC, expiring) so an
// <img>/<video> can load them without an Authorization header.

export const UPLOADS_ROOT = resolve(settings.uploadsDir);

export const MIME_EXT = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/3gpp': '3gp',
    'video/webm': 'webm',
    'application/pdf': 'pdf',
};

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);

/** Writes the bytes and returns the file name relative to UPLOADS_ROOT. */
export function saveFile(inspectionId, kind, slot, mime, buffer) {
    const dir = join(UPLOADS_ROOT, safe(inspectionId));
    mkdirSync(dir, { recursive: true });
    const name = `${safe(kind)}-${safe(slot)}-${randomBytes(4).toString('hex')}.${MIME_EXT[mime] ?? 'bin'}`;
    writeFileSync(join(dir, name), buffer);
    return `${safe(inspectionId)}/${name}`;
}

/** Absolute path of a stored file, or null if it is missing / outside the uploads folder. */
export function filePath(relative) {
    const abs = resolve(UPLOADS_ROOT, relative);
    if (!abs.startsWith(UPLOADS_ROOT) || !existsSync(abs)) return null;
    return abs;
}

export function deleteFile(relative) {
    const abs = filePath(relative);
    if (abs) rmSync(abs, { force: true });
}

const signature = (inspectionId, mediaId, exp) =>
    createHmac('sha256', settings.jwtSecret).update(`media:${inspectionId}:${mediaId}:${exp}`).digest('base64url');

/** Expiring link to one file (served by GET /media/:inspectionId/:mediaId). */
export function signedMediaUrl(inspectionId, mediaId, ttl = settings.mediaLinkTtlSeconds) {
    const exp = Math.floor(Date.now() / 1000) + ttl;
    return `/api/v1/media/${encodeURIComponent(inspectionId)}/${encodeURIComponent(mediaId)}?exp=${exp}&sig=${signature(inspectionId, mediaId, exp)}`;
}

export function verifyMediaSignature(inspectionId, mediaId, exp, sig) {
    if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
    const expected = Buffer.from(signature(inspectionId, mediaId, Number(exp)));
    const actual = Buffer.from(String(sig));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
