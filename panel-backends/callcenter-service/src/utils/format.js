// Display formats used in generated documents (PDFs, CSV). The API itself
// returns ISO timestamps and plain numbers; the portal formats those.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TZ_OFFSET_MIN = 330; // documents are for Indian customers: always IST

const ist = (iso) => new Date(new Date(iso).getTime() + TZ_OFFSET_MIN * 60_000);

/** "01 May 2025" */
export function fmtDate(iso) {
    if (!iso) return '';
    const d = ist(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "01 May 2025, 10:45 AM" */
export function fmtDateTime(iso) {
    if (!iso) return '';
    const d = ist(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const h = d.getUTCHours();
    const hh = String(h % 12 || 12).padStart(2, '0');
    return `${fmtDate(iso)}, ${hh}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Indian grouping, no decimals: 125500 -> "1,25,500". */
export const inr = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));

/** Indian grouping, 2 decimals. */
export const inr2 = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One CSV cell. */
export const csvCell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
