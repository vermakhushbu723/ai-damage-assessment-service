// CSV building for Data Download / exports. A leading BOM makes Excel open
// UTF-8 (₹, names) correctly; values starting with = + - @ are prefixed with
// a quote so a spreadsheet never runs them as formulas (CSV injection).

const escape = (value) => {
    let s = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** columns: [{ title, value: (row) => any }] */
export function toCsv(rows, columns) {
    const header = columns.map((c) => escape(c.title)).join(',');
    const body = rows.map((r) => columns.map((c) => escape(c.value(r))).join(',')).join('\r\n');
    return `﻿${header}\r\n${body}${rows.length ? '\r\n' : ''}`;
}
