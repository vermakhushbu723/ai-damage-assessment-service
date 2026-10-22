import { Router } from 'express';
import { asyncHandler, validate, badRequest, notFound } from '../utils/http.js';
import { authenticate } from '../middleware/authenticate.js';
import { DATA_TYPES, DOWNLOAD_FORMATS, DOWNLOAD_TTL_DAYS, REGIONS } from '../constants.js';
import { listDownloads, insertDownload, findDownloadRow, toDownloadDto } from '../models/downloadModel.js';
import { listClaims } from '../models/claimModel.js';
import { listUsers } from '../models/userModel.js';
import { listAuditEvents, listChanges } from '../models/auditModel.js';
import { toCsv } from '../utils/csv.js';
import { nextSequentialId } from '../utils/ids.js';
import { auditEvent } from '../services/audit.js';
import { transaction } from '../db/database.js';

const router = Router();
router.use(authenticate);

const day = (iso) => (iso ? new Date(iso).toISOString().slice(0, 10) : '');
const col = (title, value) => ({ title, value });
const EXT = { CSV: 'csv', Excel: 'xls', JSON: 'json' };
const MIME = { CSV: 'text/csv; charset=utf-8', Excel: 'application/vnd.ms-excel', JSON: 'application/json; charset=utf-8' };

/** Rows + columns + the date each data type is filtered on. */
function dataset(type) {
    const claimCols = [
        col('Claim ID', (c) => c.id), col('Customer', (c) => c.customer), col('Type', (c) => c.type), col('Handler', (c) => c.handler),
        col('Amount', (c) => c.amount), col('Status', (c) => c.stage), col('Branch', (c) => c.branch), col('Region', (c) => c.region),
        col('Intimated', (c) => day(c.intimatedAt)),
    ];
    switch (type) {
        case 'Users':
            return {
                rows: listUsers(), dateOf: (u) => u.createdAt, noRegion: true,
                columns: [col('User ID', (u) => u.userId), col('Name', (u) => u.name), col('Email', (u) => u.email), col('Employee ID', (u) => u.employeeId),
                    col('Role', (u) => u.roleKey), col('Organization', (u) => u.organization), col('Status', (u) => u.status), col('Created On', (u) => u.createdAt)],
            };
        case 'Survey':
            return { rows: listClaims().filter((c) => ['Survey', 'FLA'].includes(c.stage)), dateOf: (c) => c.intimatedAt, columns: claimCols };
        case 'Payments':
            return {
                rows: listClaims().filter((c) => c.stage === 'Settled'), dateOf: (c) => c.intimatedAt,
                columns: [col('Claim ID', (c) => c.id), col('Payee', (c) => c.customer), col('Amount', (c) => c.amount), col('Branch', (c) => c.branch), col('Region', (c) => c.region)],
            };
        case 'Audit Logs':
            return {
                rows: [
                    ...listAuditEvents().map((e) => ({ at: e.at, user: e.user, module: e.module, update: `${e.reference}: ${e.update}`, status: e.status, device: e.device })),
                    ...listChanges().map((c) => ({ at: c.changedOn, user: c.changedBy, module: c.module, update: `${c.change}: ${c.oldValue} → ${c.newValue}`, status: 'Success', device: c.device })),
                ].sort((a, b) => b.at.localeCompare(a.at)),
                dateOf: (e) => e.at,
                noRegion: true,
                columns: [col('Date & Time', (e) => e.at), col('User', (e) => e.user), col('Module', (e) => e.module), col('Update', (e) => e.update), col('Status', (e) => e.status), col('Device', (e) => e.device)],
            };
        default:
            return { rows: listClaims(), dateOf: (c) => c.intimatedAt, columns: claimCols };
    }
}

const xmlEscape = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Excel 2003 XML workbook -- opens in Excel / LibreOffice without extra libraries. */
function toExcelXml(rows, columns, sheet) {
    const cell = (v) => (typeof v === 'number' ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>` : `<Cell><Data ss:Type="String">${xmlEscape(v)}</Data></Cell>`);
    const header = `<Row>${columns.map((c) => cell(c.title)).join('')}</Row>`;
    const body = rows.map((r) => `<Row>${columns.map((c) => cell(c.value(r))).join('')}</Row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="${xmlEscape(sheet).slice(0, 31)}"><Table>${header}${body}</Table></Worksheet></Workbook>`;
}

function render(format, rows, columns, sheet) {
    if (format === 'JSON') return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c) => [c.title, c.value(r) ?? null]))), null, 2);
    if (format === 'Excel') return toExcelXml(rows, columns, sheet);
    return toCsv(rows, columns);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (iso) => { const d = new Date(iso); return `${MONTHS[d.getMonth()]}_${String(d.getDate()).padStart(2, '0')}`; };

/** GET /api/v1/downloads -> Download History (newest first). */
router.get('/', (_req, res) => res.json(listDownloads()));

/**
 * POST /api/v1/downloads { format, types: [..], from, to, region? } -- "Generate Download".
 * One file per data type, built from the database and kept DOWNLOAD_TTL_DAYS.
 * -> [download, ...] (fetch each with GET /downloads/:id/file)
 */
router.post('/', asyncHandler(async (req, res) => {
    const body = validate(req.body, {
        format: { required: true, oneOf: DOWNLOAD_FORMATS, label: 'Format' },
        types: { required: true, type: 'array', label: 'Data sets' },
        from: { required: true, label: 'From date' },
        to: { required: true, label: 'To date' },
        region: { oneOf: REGIONS, label: 'Region' },
    });
    if (!body.types.length) throw badRequest('Select at least one data set.');
    const bad = body.types.filter((t) => !DATA_TYPES.includes(t));
    if (bad.length) throw badRequest(`Unknown data set(s): ${bad.join(', ')}.`);
    for (const k of ['from', 'to']) if (Number.isNaN(Date.parse(body[k]))) throw badRequest(`${k} is not a valid date.`);
    const fromTs = new Date(body.from).setHours(0, 0, 0, 0);
    const toTs = new Date(body.to).setHours(23, 59, 59, 999);
    if (toTs < fromTs) throw badRequest('End date is before start date.');

    const created = transaction(() => [...new Set(body.types)].map((type) => {
        const ds = dataset(type);
        const rows = ds.rows.filter((r) => {
            const t = new Date(ds.dateOf(r)).getTime();
            return t >= fromTs && t <= toTs && (ds.noRegion || !body.region || r.region === body.region);
        });
        const content = render(body.format, rows, ds.columns, type);
        const fileName = `${type.replace(/\s+/g, '_')}_${short(body.from)}_to_${short(body.to)}${body.region ? `_${body.region}` : ''}.${EXT[body.format]}`;
        return insertDownload({
            id: nextSequentialId('downloads', 'DL', 1000),
            fileName,
            dataType: type,
            format: body.format,
            params: { format: body.format, from: body.from, to: body.to, region: body.region ?? null },
            rows: rows.length,
            content,
            createdBy: req.admin.id,
            createdByName: req.admin.name,
            expiresAt: new Date(Date.now() + DOWNLOAD_TTL_DAYS * 86400_000).toISOString(),
        });
    }));
    created.forEach((d) => auditEvent(req, { update: `${d.dataType} export`, reference: 'Exported', module: 'Data', detail: `${d.id} ${d.fileName} (${d.rows} rows)` }));
    res.status(201).json(created);
}));

/** GET /api/v1/downloads/:id/file -> the file (410 once expired). */
router.get('/:id/file', (req, res) => {
    const row = findDownloadRow(req.params.id);
    if (!row) throw notFound('Download');
    if (toDownloadDto(row).status !== 'Ready' || !row.content) return res.status(410).json({ detail: 'This file has expired — generate it again.' });
    auditEvent(req, { update: row.file_name, reference: 'Downloaded', module: 'Data', detail: row.id });
    res.setHeader('Content-Type', MIME[row.format] ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${row.file_name}"`);
    return res.send(row.content);
});

export default router;
