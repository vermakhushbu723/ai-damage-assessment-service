// Verify-only copy of ../../auth-service/src/utils/jwt.js's HS256 logic --
// claims-service never issues tokens (only auth-service does), it just
// needs to check the ones auth-service already signed. Kept as a separate
// copy rather than a shared package since these are two independently
// deployable services (same pattern as the _ensure_downloaded() mirror
// between ../yolo-service/app.py and ../training/scripts/train.py).

import { createHmac, timingSafeEqual } from 'node:crypto';

function base64url(input) {
    return Buffer.from(input)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function base64urlToBuffer(input) {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(input.length + (4 - (input.length % 4 || 4)) % 4, '=');
    return Buffer.from(padded, 'base64');
}

function sign(data, secret) {
    return base64url(createHmac('sha256', secret).update(data).digest());
}

export function verifyToken(token, secret) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('Malformed token');
    const [encodedHeader, encodedBody, signature] = parts;

    const expectedSignature = sign(`${encodedHeader}.${encodedBody}`, secret);
    const actual = Buffer.from(signature);
    const expected = Buffer.from(expectedSignature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error('Invalid token signature');
    }

    const payload = JSON.parse(base64urlToBuffer(encodedBody).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && now >= payload.exp) {
        throw new Error('Token expired');
    }
    return payload;
}
