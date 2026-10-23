import express, { Router } from 'express';
import { db, nowIso, transaction } from '../db/database.js';
import { settings } from '../config.js';
import { badRequest, notFound, HttpError } from '../utils/http.js';
import { authenticate, can, actorOf } from '../middleware/authenticate.js';
import { MODULES, DOC_TYPES, REQUIRED_DOC_TYPES, UPLOAD_MIME } from '../constants.js';
import { audit } from '../models/claimModel.js';
import { saveFile, readFile, signedFileUrl, verifyFileSignature } from '../services/fileStore.js';
import { nextSequentialId, sha256 } from '../utils/ids.js';
import { loadClaim } from './claims.js';
import { buildZip } from '../utils/zip.js';
import { pdfImage, sendPdf } from '../utils/pdf.js';
import { fmtDateTime } from '../utils/format.js';

// Documents DMS: per-claim uploads by document type. Types that hold one
// paper (RC, DL, policy, ...) keep only the newest file as current; the older
// one is marked replaced. Photos / other documents keep every file.

/** Types where every upload adds a file instead of replacing the last one. */
const MULTI = ['vehicle-photos', 'other', 'kyc', 'aadhar', 'surveyor-report'];

export const toDocument = (d) => ({
    id: d.id,
    type: d.doc_type,
    typeLabel: DOC_TYPES[d.doc_type] ?? d.doc_type,
    name: d.file_name,
    mime: d.mime,
    size: d.size,
    sha256: d.sha256,
    uploadedBy: d.uploaded_by_name,
    uploadedById: d.uploaded_by,
    uploadedAt: d.uploaded_at,
    url: signedFileUrl(d.id),
});

export const currentDocuments = (claimId) =>
    db.prepare('SELECT * FROM documents WHERE claim_id = ? AND replaced_at IS NULL ORDER BY uploaded_at DESC, id DESC').all(claimId).map(toDocument);

export function documentsState(claimId) {
    const files = currentDocuments(claimId);
    const types = Object.entries(DOC_TYPES).map(([type, label]) => {
        const ofType = files.filter((f) => f.type === type);
        return {
            type,
            label,
            required: REQUIRED_DOC_TYPES.includes(type),
            status: ofType.length ? 'uploaded' : REQUIRED_DOC_TYPES.includes(type) ? 'pending' : 'none',
            count: ofType.length,
            latest: ofType[0] ?? null,
        };
    });
    return { types, files, pending: types.filter((t) => t.status === 'pending').map((t) => t.label) };
}

// Signed file links -- public (no Bearer header possible on <img>/<iframe>).
export const filesRouter = Router();
filesRouter.get('/files/:docId', (req, res) => {
    if (!verifyFileSignature(req.params.docId, req.query.exp, req.query.sig)) throw new HttpError(403, 'This file link has expired. Reload the page.');
    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.docId);
    if (!d) throw notFound('File');
    const buf = readFile(d.claim_id, d.stored_name);
    if (!buf) throw notFound('File');
    res.setHeader('Content-Type', d.mime);
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${d.file_name.replace(/[^A-Za-z0-9._ -]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.end(buf);
});

const router = Router();
router.use(authenticate);

const VIEW = [MODULES.dms, MODULES.details, MODULES.aiIla, MODULES.intimation];

/** GET /api/v1/claims/:id/documents -- document types with status + current files. */
router.get('/claims/:id/documents', can(VIEW), (req, res) => {
    const row = loadClaim(req);
    res.json(documentsState(row.id));
});

/**
 * PUT /api/v1/claims/:id/documents/:type -- raw file body; Content-Type = the
 * file's type (JPG / PNG / WEBP / PDF), X-File-Name = its name (URI-encoded).
 */
router.put(
    '/claims/:id/documents/:type',
    can([MODULES.dms, MODULES.intimation], 'create'),
    express.raw({ type: () => true, limit: `${settings.maxUploadMb}mb` }),
    (req, res) => {
        const row = loadClaim(req);
        const type = req.params.type;
        if (!DOC_TYPES[type]) throw badRequest('Unknown document type.');
        const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        const ext = UPLOAD_MIME[mime];
        if (!ext) throw badRequest('Only JPG, PNG, WEBP or PDF files can be uploaded.');
        if (type === 'vehicle-photos' && mime === 'application/pdf') throw badRequest('Vehicle photos must be images.');
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || !buf.length) throw badRequest('The file is empty.');
        let name = 'document';
        try {
            name = decodeURIComponent(String(req.headers['x-file-name'] || 'document'));
        } catch {
            /* keep default */
        }
        name = name.replace(/[\\/]/g, '_').slice(0, 120) || 'document';

        const actor = actorOf(req);
        const storedName = saveFile(row.id, buf, ext);
        const id = nextSequentialId('documents', 'DOC');
        transaction(() => {
            if (!MULTI.includes(type)) {
                db.prepare('UPDATE documents SET replaced_at = ? WHERE claim_id = ? AND doc_type = ? AND replaced_at IS NULL').run(nowIso(), row.id, type);
            }
            db.prepare(`INSERT INTO documents (id, claim_id, doc_type, file_name, mime, size, sha256, stored_name, uploaded_by, uploaded_by_name, uploaded_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(id, row.id, type, name, mime, buf.length, sha256(buf), storedName, actor.id, actor.name, nowIso());
            audit(row.id, 'Document uploaded', `${DOC_TYPES[type]} · ${name}`, actor);
        });
        res.status(201).json({ document: toDocument(db.prepare('SELECT * FROM documents WHERE id = ?').get(id)), ...documentsState(row.id) });
    },
);

/** POST /api/v1/claims/:id/documents/process -- "Upload & Process": all required papers present? */
router.post('/claims/:id/documents/process', can(MODULES.dms, 'edit'), (req, res) => {
    const row = loadClaim(req);
    const state = documentsState(row.id);
    if (state.pending.length) throw badRequest(`${state.pending.length} document(s) still pending: ${state.pending.join(', ')}.`, { pending: state.pending });
    audit(row.id, 'Documents processed', `${state.files.length} file(s) verified complete`, actorOf(req));
    res.json({ ok: true, ...state });
});

/** Current files of the claim with their bytes (missing files skipped). */
function filesWithData(row) {
    return db.prepare('SELECT * FROM documents WHERE claim_id = ? AND replaced_at IS NULL ORDER BY doc_type, uploaded_at').all(row.id)
        .map((d) => ({ d, data: readFile(row.id, d.stored_name) }))
        .filter((f) => f.data);
}

/** GET /api/v1/claims/:id/documents/download.zip -- "Download As Zip File": every current file, one folder per type. */
router.get('/claims/:id/documents/download.zip', can(MODULES.dms, 'download'), (req, res) => {
    const row = loadClaim(req);
    const files = filesWithData(row);
    if (!files.length) throw badRequest('No documents uploaded for this claim yet.');
    const seen = new Set();
    const zip = buildZip(files.map(({ d, data }) => {
        let name = `${DOC_TYPES[d.doc_type] ?? d.doc_type}/${d.file_name}`.replace(/[\\:*?"<>|]/g, '_');
        if (seen.has(name)) name = name.replace(/(\.[^./]+)?$/, `-${d.id}$1`);
        seen.add(name);
        return { name, data, date: new Date(d.uploaded_at) };
    }));
    audit(row.id, 'Documents downloaded', `ZIP · ${files.length} file(s)`, actorOf(req));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Documents-${row.claim_no}.zip"`);
    res.setHeader('Content-Length', zip.length);
    res.end(zip);
});

/**
 * GET /api/v1/claims/:id/documents/download.pdf -- "Download As PDF": the
 * document register plus every JPG / PNG on its own page (PDF files and other
 * images are listed; they are in the ZIP).
 */
router.get('/claims/:id/documents/download.pdf', can(MODULES.dms, 'download'), (req, res) => {
    const row = loadClaim(req);
    const files = filesWithData(row);
    if (!files.length) throw badRequest('No documents uploaded for this claim yet.');
    const pages = files.map((f) => ({ ...f, image: f.d.mime.startsWith('image/') ? pdfImage(f.data) : null }));
    audit(row.id, 'Documents downloaded', `PDF · ${files.length} file(s)`, actorOf(req));
    sendPdf(res, `Documents-${row.claim_no}.pdf`, [
        { text: 'IBIMA ASSIST - CLAIM DOCUMENTS', size: 14, bold: true, align: 'center' },
        { text: `${row.claim_no} · ${row.insured_name ?? ''} · ${row.vehicle_no ?? ''}`, size: 9, align: 'center', gap: 2 },
        { rule: true, gap: 8 },
        ...pages.map((p, i) => ({
            cols: [`${i + 1}. ${DOC_TYPES[p.d.doc_type] ?? p.d.doc_type} - ${p.d.file_name}${p.image ? '' : ' (in ZIP)'}`, `${p.d.uploaded_by_name ?? ''} ${fmtDateTime(p.d.uploaded_at)}`],
            size: 9,
        })),
        { text: `Generated ${fmtDateTime(nowIso())}`, size: 8, gap: 12 },
        ...pages.filter((p) => p.image).map((p) => ({ image: p.image, caption: `${DOC_TYPES[p.d.doc_type] ?? p.d.doc_type} - ${p.d.file_name}` })),
    ]);
});

export default router;
