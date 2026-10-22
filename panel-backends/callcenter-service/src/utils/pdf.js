// Tiny text-only PDF writer (A4, Helvetica) for the documents this portal
// hands out: letters, the ILA draft, the liability report and the survey
// paybill. No dependency: a PDF of text lines is ~80 lines of PDF syntax.

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 50;

/** Helvetica only knows WinAnsi; keep text printable. */
const clean = (text) => String(text ?? '')
    .replace(/₹/g, 'Rs. ')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/·/g, '-')
    .replace(/[^\x20-\x7E]/g, '');

const escape = (text) => clean(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Splits text into lines that fit `width` points at `size` (Helvetica averages ~0.5em per char). */
function wrap(text, size, width = PAGE_W - 2 * MARGIN) {
    const max = Math.max(10, Math.floor(width / (size * 0.5)));
    const out = [];
    for (const paragraph of clean(text).split('\n')) {
        let line = '';
        for (const word of paragraph.split(' ')) {
            if (!line) line = word;
            else if ((`${line} ${word}`).length <= max) line = `${line} ${word}`;
            else {
                out.push(line);
                line = word;
            }
            while (line.length > max) {
                out.push(line.slice(0, max));
                line = line.slice(max);
            }
        }
        out.push(line);
    }
    return out;
}

/**
 * blocks: [{ text, size?=10, bold?, align?: 'left'|'center'|'right', gap?: points before, cols?: [left, right] }]
 * `cols` prints a two-column row (label left, value right-aligned).
 */
export function buildPdf(blocks) {
    const pages = [[]];
    let y = PAGE_H - MARGIN;
    const put = (op, size) => {
        if (y < MARGIN + size) {
            pages.push([]);
            y = PAGE_H - MARGIN;
        }
        pages[pages.length - 1].push(op(y));
    };

    for (const b of blocks) {
        const size = b.size ?? 10;
        const font = b.bold ? 'F2' : 'F1';
        y -= b.gap ?? 0;
        if (b.rule) {
            put((yy) => `${MARGIN} ${yy} m ${PAGE_W - MARGIN} ${yy} l S`, 4);
            y -= 8;
            continue;
        }
        if (b.cols) {
            const [left, right] = b.cols.map((c) => escape(c));
            const rightX = PAGE_W - MARGIN - clean(b.cols[1]).length * size * 0.5;
            put((yy) => `BT /${font} ${size} Tf ${MARGIN} ${yy} Td (${left}) Tj ET BT /${font} ${size} Tf ${rightX.toFixed(1)} ${yy} Td (${right}) Tj ET`, size);
            y -= size * 1.5;
            continue;
        }
        for (const line of wrap(b.text, size)) {
            const w = line.length * size * 0.5;
            const x = b.align === 'center' ? (PAGE_W - w) / 2 : b.align === 'right' ? PAGE_W - MARGIN - w : MARGIN;
            put((yy) => `BT /${font} ${size} Tf ${x.toFixed(1)} ${yy} Td (${escape(line)}) Tj ET`, size);
            y -= size * 1.45;
        }
    }

    // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, then page + content pairs.
    const objects = [];
    const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
    objects.push('<< /Type /Catalog /Pages 2 0 R >>');
    objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    pages.forEach((ops, i) => {
        const stream = `0.75 w\n${ops.join('\n')}`;
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`);
        objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    });

    let pdf = '%PDF-1.4\n';
    const offsets = [];
    objects.forEach((body, i) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, 'latin1');
}

/** Sends a PDF as a download. */
export function sendPdf(res, fileName, blocks) {
    const buf = buildPdf(blocks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
}
