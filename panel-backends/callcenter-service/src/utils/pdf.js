// Tiny PDF writer (A4, Helvetica) for the documents this portal hands out:
// letters, the ILA draft, liability reports, the survey paybill and the DMS
// bundle. No dependency: text lines + JPEG / PNG images are a few dozen lines
// of PDF syntax.

import { inflateSync, deflateSync } from 'node:zlib';

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

// ---------- images ----------

/** JPEG -> { filter: DCTDecode, width, height, colors, data } or null. */
function jpegInfo(buf) {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xcb)) {
            const colors = buf[i + 9];
            return { filter: 'DCTDecode', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), colors, data: buf, decode: colors === 4 ? '/Decode [1 0 1 0 1 0 1 0]' : '' };
        }
        i += 2 + len;
    }
    return null;
}

/** PNG (8-bit gray / RGB, not interlaced) -> FlateDecode with the PNG predictor, or null. */
function pngInfo(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) return null;
    let i = 8;
    let ihdr = null;
    const idat = [];
    while (i < buf.length) {
        const len = buf.readUInt32BE(i);
        const type = buf.toString('latin1', i + 4, i + 8);
        const data = buf.subarray(i + 8, i + 8 + len);
        if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        i += 12 + len;
    }
    if (!ihdr || ihdr.depth !== 8 || ihdr.interlace || ![0, 2, 4, 6].includes(ihdr.color)) return null;
    if (ihdr.color === 4 || ihdr.color === 6) return pngWithoutAlpha(ihdr, Buffer.concat(idat));
    const colors = ihdr.color === 2 ? 3 : 1;
    return {
        filter: 'FlateDecode', width: ihdr.width, height: ihdr.height, colors, data: Buffer.concat(idat), decode: '',
        parms: `/DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${ihdr.width} >>`,
    };
}

/** PNG with alpha (gray+A / RGBA): un-filter the rows, drop alpha (over white), re-compress. */
function pngWithoutAlpha(ihdr, compressed) {
    const src = inflateSync(compressed);
    const bpp = ihdr.color === 6 ? 4 : 2;
    const colors = bpp - 1;
    const stride = ihdr.width * bpp;
    const out = Buffer.alloc(ihdr.width * ihdr.height * colors);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < ihdr.height; y++) {
        const filter = src[y * (stride + 1)];
        const row = Buffer.from(src.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? row[x - bpp] : 0;
            const b = prev[x];
            const c = x >= bpp ? prev[x - bpp] : 0;
            let add = 0;
            if (filter === 1) add = a;
            else if (filter === 2) add = b;
            else if (filter === 3) add = (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            row[x] = (row[x] + add) & 0xff;
        }
        for (let x = 0; x < ihdr.width; x++) {
            const alpha = row[x * bpp + colors] / 255;
            for (let k = 0; k < colors; k++) out[(y * ihdr.width + x) * colors + k] = Math.round(row[x * bpp + k] * alpha + 255 * (1 - alpha));
        }
        prev = row;
    }
    return { filter: 'FlateDecode', width: ihdr.width, height: ihdr.height, colors, data: deflateSync(out), decode: '' };
}

/** Image that can go into a PDF page, or null (other formats are listed, not embedded). */
export const pdfImage = (buf) => {
    try {
        return jpegInfo(buf) ?? pngInfo(buf);
    } catch {
        return null;
    }
};

/**
 * blocks: [{ text, size?=10, bold?, align?: 'left'|'center'|'right', gap?: points before, cols?: [left, right] }
 *          | { rule: true } | { image: pdfImage(...), caption? } (an image gets its own page)]
 */
export function buildPdf(blocks) {
    const pages = [{ ops: [], images: [] }];
    const images = [];
    let y = PAGE_H - MARGIN;
    const newPage = () => {
        pages.push({ ops: [], images: [] });
        y = PAGE_H - MARGIN;
    };
    const put = (op, size) => {
        if (y < MARGIN + size) newPage();
        pages[pages.length - 1].ops.push(op(y));
    };

    for (const b of blocks) {
        const size = b.size ?? 10;
        const font = b.bold ? 'F2' : 'F1';
        if (b.image) {
            if (pages[pages.length - 1].ops.length) newPage();
            const img = b.image;
            const name = `Im${images.length + 1}`;
            images.push(img);
            const page = pages[pages.length - 1];
            page.images.push({ name, index: images.length - 1 });
            const top = b.caption ? 30 : 0;
            const scale = Math.min((PAGE_W - 2 * MARGIN) / img.width, (PAGE_H - 2 * MARGIN - top) / img.height, 1.5);
            const w = img.width * scale;
            const h = img.height * scale;
            const x = (PAGE_W - w) / 2;
            const yy = PAGE_H - MARGIN - top - h;
            if (b.caption) page.ops.push(`BT /F2 11 Tf ${MARGIN} ${PAGE_H - MARGIN - 12} Td (${escape(b.caption)}) Tj ET`);
            page.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${yy.toFixed(2)} cm /${name} Do Q`);
            newPage();
            continue;
        }
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
    const used = pages.filter((p) => p.ops.length);
    if (!used.length) used.push({ ops: [], images: [] });

    // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, images, then page + content pairs.
    const parts = []; // each: string or { head, stream: Buffer }
    const imgBase = 5;
    const pageBase = imgBase + images.length;
    const kids = used.map((_, i) => `${pageBase + i * 2} 0 R`).join(' ');
    parts.push('<< /Type /Catalog /Pages 2 0 R >>');
    parts.push(`<< /Type /Pages /Kids [${kids}] /Count ${used.length} >>`);
    parts.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    parts.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    for (const img of images) {
        const cs = img.colors === 1 ? '/DeviceGray' : img.colors === 4 ? '/DeviceCMYK' : '/DeviceRGB';
        parts.push({
            head: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /${img.filter} ${img.parms ?? ''} ${img.decode} /Length ${img.data.length} >>`,
            stream: img.data,
        });
    }
    used.forEach((page, i) => {
        const xobj = page.images.length ? `/XObject << ${page.images.map((m) => `/${m.name} ${imgBase + m.index} 0 R`).join(' ')} >>` : '';
        const stream = Buffer.from(`0.75 w\n${page.ops.join('\n')}`, 'latin1');
        parts.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> ${xobj} >> /Contents ${pageBase + i * 2 + 1} 0 R >>`);
        parts.push({ head: `<< /Length ${stream.length} >>`, stream });
    });

    const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let size = chunks[0].length;
    const offsets = [];
    parts.forEach((part, i) => {
        offsets.push(size);
        const bufs = typeof part === 'string'
            ? [Buffer.from(`${i + 1} 0 obj\n${part}\nendobj\n`, 'latin1')]
            : [Buffer.from(`${i + 1} 0 obj\n${part.head}\nstream\n`, 'latin1'), part.stream, Buffer.from('\nendstream\nendobj\n', 'latin1')];
        bufs.forEach((b) => {
            chunks.push(b);
            size += b.length;
        });
    });
    let tail = `xref\n0 ${parts.length + 1}\n0000000000 65535 f \n`;
    tail += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    tail += `trailer\n<< /Size ${parts.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`;
    chunks.push(Buffer.from(tail, 'latin1'));
    return Buffer.concat(chunks);
}

/** Sends a PDF as a download. */
export function sendPdf(res, fileName, blocks) {
    const buf = buildPdf(blocks);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
}
