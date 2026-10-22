import { Router } from 'express';
import { asyncHandler, badRequest, checkPassword } from '../utils/http.js';
import { sha256 } from '../utils/ids.js';
import { hashPassword } from '../utils/password.js';
import { findResetToken, markResetTokenUsed, findUser, setUserPassword } from '../models/userModel.js';
import { BLOCKED_STATUSES } from '../constants.js';
import { auditEvent } from '../services/audit.js';
import { transaction } from '../db/database.js';

// Public: the page a "Send Link" reset link opens. No sign-in -- the token is the proof.
const router = Router();

function usableToken(token) {
    const row = findResetToken(sha256(String(token ?? '')));
    if (!row || row.used_at) throw badRequest('This reset link is invalid or has already been used.');
    if (new Date(row.expires_at) < new Date()) throw badRequest('This reset link has expired. Ask your admin for a new one.');
    const user = findUser(row.user_id);
    if (!user) throw badRequest('This reset link is invalid.');
    if (BLOCKED_STATUSES.includes(user.status)) throw badRequest(`This account is ${user.status}. Contact your admin.`);
    return { row, user };
}

/** GET /api/v1/password-reset/:token -> { name, userId, expiresAt } */
router.get('/:token', asyncHandler(async (req, res) => {
    const { row, user } = usableToken(req.params.token);
    res.json({ name: user.name, userId: user.userId, expiresAt: row.expires_at });
}));

/** POST /api/v1/password-reset/confirm { token, password } */
router.post('/confirm', asyncHandler(async (req, res) => {
    const { row, user } = usableToken(req.body?.token);
    checkPassword(req.body?.password);
    transaction(() => {
        setUserPassword(user.id, hashPassword(req.body.password), { mustChange: false });
        markResetTokenUsed(row.token_hash);
    });
    auditEvent(req, { update: `Password · ${user.userId}`, reference: 'Password Reset', module: 'Security', detail: 'Reset via link', actor: { id: user.id, name: user.name, role: 'User' } });
    res.json({ ok: true });
}));

export default router;
