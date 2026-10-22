import { Router } from 'express';
import { asyncHandler, badRequest, checkPassword } from '../utils/http.js';
import { findResetToken, markResetTokenUsed, findUser, setUserPassword } from '../models/userModel.js';
import { hashPassword } from '../utils/password.js';
import { sha256 } from '../utils/ids.js';
import { transaction } from '../db/database.js';
import { audit } from '../services/audit.js';

// Public (no login): used by the page a "Send Link" link opens.
const router = Router();

function loadValidToken(token) {
    const row = token ? findResetToken(sha256(String(token))) : null;
    if (!row) throw badRequest('This reset link is invalid.');
    if (row.used_at) throw badRequest('This reset link has already been used or replaced by a newer one.');
    if (new Date(row.expires_at) < new Date()) throw badRequest('This reset link has expired. Ask your administrator for a new one.');
    return row;
}

/** GET /api/v1/password-reset/:token -> { name, userId, expiresAt } if the link is still usable. */
router.get('/:token', (req, res) => {
    const row = loadValidToken(req.params.token);
    const user = findUser(row.user_id);
    res.json({ userId: user.id, name: user.name, expiresAt: row.expires_at });
});

/** POST /api/v1/password-reset/confirm { token, password } */
router.post('/confirm', asyncHandler(async (req, res) => {
    const row = loadValidToken(req.body?.token);
    checkPassword(req.body?.password, 'New password');
    transaction(() => {
        setUserPassword(row.user_id, hashPassword(req.body.password), false);
        markResetTokenUsed(row.token_hash);
    });
    const user = findUser(row.user_id);
    audit(req, { action: 'Updated', module: 'Users', detail: `${user.id} set a new password via reset link`, actor: { id: user.id, name: user.name, role: user.role } });
    res.json({ ok: true, userId: user.id });
}));

export default router;
