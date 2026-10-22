import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { settings } from '../config.js';
import { randomToken } from '../utils/ids.js';

// Documents DMS files live on disk: UPLOADS_DIR/<claim id>/<random name>.
// The portal shows them with <img>/<iframe>, which cannot send a Bearer
// token, so file URLs are signed links (/files/:docId?exp=&sig=) handed out
// only to users allowed to see the claim's documents.

const root = () => resolve(settings.uploadsDir);
const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '');

export function saveFile(claimId, buffer, ext) {
    const dir = join(root(), safe(claimId));
    mkdirSync(dir, { recursive: true });
    const storedName = `${randomToken(12)}${ext}`;
    writeFileSync(join(dir, storedName), buffer);
    return storedName;
}

export function readFile(claimId, storedName) {
    const path = join(root(), safe(claimId), safe(storedName.replace(/\.[a-z]+$/, '')) + (storedName.match(/\.[a-z]+$/)?.[0] ?? ''));
    return existsSync(path) ? readFileSync(path) : null;
}

const signature = (docId, exp) => createHmac('sha256', `${settings.jwtSecret}:files`).update(`${docId}.${exp}`).digest('base64url');

/** Relative URL (under /api/v1) the browser can open for a while. */
export function signedFileUrl(docId) {
    const exp = Math.floor(Date.now() / 1000) + settings.fileLinkTtlSeconds;
    return `/files/${encodeURIComponent(docId)}?exp=${exp}&sig=${signature(docId, exp)}`;
}

export function verifyFileSignature(docId, exp, sig) {
    if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
    const a = Buffer.from(String(sig));
    const b = Buffer.from(signature(docId, Number(exp)));
    return a.length === b.length && timingSafeEqual(a, b);
}
