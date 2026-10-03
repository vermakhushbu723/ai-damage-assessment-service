// Small request helpers shared by every route: typed HTTP errors, async
// handler wrapping, and the field validators the routes use.

export class HttpError extends Error {
    constructor(status, detail, extra = {}) {
        super(detail);
        this.status = status;
        this.detail = detail;
        this.extra = extra;
    }
}

export const badRequest = (detail, extra) => new HttpError(400, detail, extra);
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found.`);
export const forbidden = (detail = 'You are not allowed to do this.') => new HttpError(403, detail);
export const conflict = (detail) => new HttpError(409, detail);

/** Wraps an async route so a thrown error reaches the error middleware. */
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isEmail = (v) => typeof v === 'string' && EMAIL_RE.test(v.trim());
/** Last 10 digits of an Indian mobile number ("+91 98765 43210" -> "9876543210"), or '' if not one. */
export const normalizePhone = (v) => {
    const digits = String(v ?? '').replace(/\D/g, '');
    const ten = digits.length > 10 ? digits.slice(-10) : digits;
    return /^[6-9]\d{9}$/.test(ten) ? ten : '';
};

/**
 * Validates `body` against a spec and returns only the known keys.
 * spec: { field: { required?, type?: 'string'|'number'|'boolean'|'object'|'array', oneOf?, email?, phone?, min?, max?, label? } }
 * Unknown keys are dropped; `partial` skips required checks (PATCH).
 */
export function validate(body, spec, { partial = false } = {}) {
    const input = body && typeof body === 'object' ? body : {};
    const out = {};
    const errors = {};
    for (const [key, rule] of Object.entries(spec)) {
        const label = rule.label ?? key;
        let value = input[key];
        if (typeof value === 'string') value = value.trim();
        const missing = value === undefined || value === null || value === '';
        if (missing) {
            if (rule.required && !partial) errors[key] = `${label} is required.`;
            else if (key in input) out[key] = rule.type === 'array' ? [] : null;
            continue;
        }
        const type = rule.type ?? 'string';
        if (type === 'array' ? !Array.isArray(value) : type === 'object' ? (typeof value !== 'object' || Array.isArray(value)) : typeof value !== type) {
            errors[key] = `${label} must be a ${type}.`;
            continue;
        }
        if (rule.oneOf && !rule.oneOf.includes(value)) errors[key] = `${label} must be one of: ${rule.oneOf.join(', ')}.`;
        else if (rule.email && !isEmail(value)) errors[key] = `${label} must be a valid email address.`;
        else if (rule.phone && !normalizePhone(value)) errors[key] = `${label} must be a valid 10-digit mobile number.`;
        else if (type === 'string' && rule.min && value.length < rule.min) errors[key] = `${label} must be at least ${rule.min} characters.`;
        else if (type === 'string' && rule.max && value.length > rule.max) errors[key] = `${label} must be at most ${rule.max} characters.`;
        else if (type === 'number' && rule.min !== undefined && value < rule.min) errors[key] = `${label} must be at least ${rule.min}.`;
        else out[key] = value;
    }
    if (Object.keys(errors).length) {
        throw badRequest(Object.values(errors)[0], { errors });
    }
    return out;
}

/** Password policy for every password this service stores. */
export function checkPassword(password, label = 'Password') {
    if (typeof password !== 'string' || password.length < 8) throw badRequest(`${label} must be at least 8 characters.`);
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw badRequest(`${label} must contain letters and numbers.`);
    if (password.length > 128) throw badRequest(`${label} is too long.`);
}
