import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound, HttpError } from '../utils/http.js';
import { authenticate, serviceModelOfAdmin } from '../middleware/authenticate.js';
import { DATA_TYPES, DOWNLOAD_FORMATS, DOWNLOAD_TTL_DAYS } from '../constants.js';
import { listDownloads, insertDownload, findDownloadRow, toDownloadDto } from '../models/downloadModel.js';
import { listClaims } from '../models/claimModel.js';
import { listUsers } from '../models/userModel.js';
import { listOrganizations, findOrganization } from '../models/organizationModel.js';
import { listAuditLogs } from '../models/auditModel.js';
import { toCsv } from '../utils/csv.js';
import { nextSequentialId } from '../utils/ids.js';
import { audit } from '../services/audit.js';

const router = Router();
router.use(authenticate);

const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const col = (title, value) => ({ title, value });

/** Rows + columns + the date field each data type is filtered on. */
function dataset(type, serviceModel) {
    switch (type) {
        case 'Users':
            return {
                rows: listUsers(serviceModel), dateOf: (r) => r.createdOn,
                columns: [col('User ID', (r) => r.id), col('Name', (r) => r.name), col('Email', (r) => r.email), col('Phone', (r) => r.phone),
                    col('Organization', (r) => r.organization), col('Role', (r) => r.role), col('Branch', (r) => r.branch), col('Status', (r) => r.status),
                    col('Last Login', (r) => r.lastLogin), col('Created On', (r) => r.createdOn)],
            };
        case 'Organizations':
            return {
                rows: listOrganizations(serviceModel), dateOf: (r) => r.createdOn,
                columns: [col('Organization ID', (r) => r.id), col('Name', (r) => r.name), col('Type', (r) => r.type), col('Service Model', (r) => r.serviceModel),
                    col('ID Type', (r) => r.idType), col('Status', (r) => r.status), col('Plan', (r) => r.plan), col('Users', (r) => r.users), col('Claims', (r) => r.claims),
                    col('Valid Till', (r) => day(r.subscriptionExpiry)), col('Created On', (r) => r.createdOn)],
            };
        case 'Audit Logs':
            return {
                rows: listAuditLogs({ limit: 5000 }), dateOf: (r) => r.timestamp, noOrg: true,
                columns: [col('Time stamp', (r) => r.timestamp), col('User', (r) => r.user), col('Role', (r) => r.role), col('Action', (r) => r.action),
                    col('Module', (r) => r.module), col('Status', (r) => r.status), col('Detail', (r) => r.detail), col('IP', (r) => r.ip), col('Device', (r) => r.device)],
            };
        default: {
            // Claims, Survey (claims in survey/assessment stages), Payments (settled claims)
            const claims = listClaims(serviceModel);
            const rows = type === 'Survey' ? claims.filter((c) => ['Survey', 'AI ILA', 'ILA', 'FLA'].includes(c.status))
                : type === 'Payments' ? claims.filter((c) => c.status === 'Settled') : claims;
            const base = [col('Claim ID', (r) => r.id), col('Customer', (r) => r.customer), col('Organization', (r) => r.organization)];
            const columns = type === 'Payments'
                ? [...base, col('Amount (INR)', (r) => r.amount), col('Settled On', (r) => day(r.settledAt)), col('Intimation Date', (r) => day(r.intimationDate))]
                : [...base, col('Claim Type', (r) => r.claimType), col('Product Type', (r) => r.productType), col('Handler', (r) => r.handler),
                    col('Amount', (r) => r.amount), col('SLA (days)', (r) => r.slaDays), col('Status', (r) => r.status), col('Branch', (r) => r.branch),
                    col('Region', (r) => r.region), col('State', (r) => r.state), col('Intimation Date', (r) => day(r.intimationDate))];
            return { rows, dateOf: (r) => r.intimationDate, columns };
        }
    }
}

const sanitizeName = (s) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** GET /api/v1/downloads -> Download History (newest first). */
router.get('/', (_req, res) => res.json(listDownloads()));

/**
 * POST /api/v1/downloads { dataType, format, from?, to?, organizationId? } -- "Generate Download".
 * Builds the CSV now from the database and keeps it for DOWNLOAD_TTL_DAYS.
 */
router.post('/', asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        dataType: { required: true, oneOf: DATA_TYPES, label: 'Data type' },
        format: { required: true, oneOf: DOWNLOAD_FORMATS, label: 'Format' },
        from: { label: 'From date' },
        to: { label: 'To date' },
        organizationId: { label: 'Organization' },
    });
    for (const k of ['from', 'to']) if (body[k] && Number.isNaN(Date.parse(body[k]))) throw badRequest(`${k} is not a valid date.`);
    if (body.from && body.to && new Date(body.to) < new Date(body.from)) throw badRequest('End date is before start date.');

    const own = serviceModelOfAdmin(req.admin);
    let org = null;
    if (body.organizationId) {
        org = findOrganization(body.organizationId);
        if (!org || (own && org.serviceModel !== own)) throw badRequest('Selected organization does not exist.');
    }

    const ds = dataset(body.dataType, own);
    const fromTs = body.from ? new Date(body.from).setHours(0, 0, 0, 0) : null;
    const toTs = body.to ? new Date(body.to).setHours(23, 59, 59, 999) : null;
    const rows = ds.rows.filter((r) => {
        const t = new Date(ds.dateOf(r)).getTime();
        if (fromTs && t < fromTs) return false;
        if (toTs && t > toTs) return false;
        if (org && !ds.noOrg) return (r.organizationId ?? r.id) === org.id;
        return true;
    });
    if (!rows.length) throw new HttpError(422, 'No records for this selection -- widen the date range or clear the filter.');

    const content = toCsv(rows, ds.columns);
    const period = body.from || body.to ? `${day(body.from) || 'start'}_to_${day(body.to) || day(new Date().toISOString())}` : day(new Date().toISOString());
    const fileName = `${sanitizeName(body.dataType)}${org ? `_${org.id}` : ''}_${period}.csv`;
    const record = insertDownload({
        id: nextSequentialId('downloads', 'DL', 1000),
        fileName,
        dataType: body.dataType,
        format: body.format,
        params: { from: body.from ?? null, to: body.to ?? null, organizationId: org?.id ?? null },
        rows: rows.length,
        sizeBytes: Buffer.byteLength(content),
        content,
        createdBy: req.admin.id,
        createdByName: req.admin.name,
        expiresAt: new Date(Date.now() + DOWNLOAD_TTL_DAYS * 86400_000).toISOString(),
    });
    audit(req, { action: 'Exported', module: 'Data', detail: `${record.id} ${fileName} (${rows.length} rows)` });
    res.status(201).json(record);
}));

/** GET /api/v1/downloads/:id/file -> the CSV (410 once expired). */
router.get('/:id/file', (req, res) => {
    const row = findDownloadRow(req.params.id);
    if (!row) throw notFound('Download');
    const dto = toDownloadDto(row);
    if (dto.status !== 'Ready') return res.status(410).json({ detail: 'This file has expired. Generate it again.' });
    audit(req, { action: 'Downloaded', module: 'Data', detail: `${row.id} ${row.file_name}` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
    return res.send(row.content);
});

export default router;
