// Password hashing via Node's built-in scrypt -- no bcrypt/argon2 dependency
// (both need native builds; this repo already moved off Python/native
// toolchains once for exactly this reason, see ../../server's history).
// Stored format: "<saltHex>:<hashHex>", so verify() doesn't need a
// separate column for the salt.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

export function hashPassword(plainPassword) {
    const salt = randomBytes(16);
    const hash = scryptSync(plainPassword, salt, KEY_LENGTH);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(plainPassword, storedHash) {
    const [saltHex, hashHex] = String(storedHash).split(':');
    if (!saltHex || !hashHex) return false;

    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(plainPassword, salt, expected.length);

    // Buffers must be equal length for timingSafeEqual -- expected.length
    // came from the stored hash, actual was derived at that same length,
    // so this only fails if the stored hash itself is malformed.
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
}
