import { timingSafeEqual } from 'node:crypto';
import { settings } from '../config.js';

/** True when `given` (an X-Service-Key header) equals CLAIMS_INGEST_KEY. */
export const serviceKeyMatches = (given) => {
    if (!settings.claimsIngestKey || !given) return false;
    const a = Buffer.from(String(given));
    const b = Buffer.from(settings.claimsIngestKey);
    return a.length === b.length && timingSafeEqual(a, b);
};
