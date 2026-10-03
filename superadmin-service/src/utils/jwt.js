// Minimal hand-rolled HS256 JWT sign/verify -- deliberately not pulling in
// the `jsonwebtoken` package. This service only needs "sign a small JSON
// payload, verify it later, reject if expired/tampered" -- node:crypto's
// createHmac covers that in ~40 lines with zero extra dependencies, which
// fits this repo's existing preference for avoiding dependencies where a
// built-in does the job (see ../../server/src/db/database.js).
//
// Token shape is a standard 3-part JWT (header.payload.signature, base64url,
// HS256) so it's still readable/debuggable with any standard JWT tool --
// it just isn't parsed by a library on this end.

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

/**
 * @param {object} payload - claims to embed (e.g. { sub, role, username, name })
 * @param {string} secret
 * @param {number} expiresInSeconds
 */
export function signToken(payload, secret, expiresInSeconds) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const body = { ...payload, iat: now, exp: now + expiresInSeconds };

    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(body))}`;
    const signature = sign(signingInput, secret);
    return `${signingInput}.${signature}`;
}

/**
 * @returns {object} the decoded payload if valid
 * @throws {Error} if the token is malformed, tampered with, or expired
 */
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
