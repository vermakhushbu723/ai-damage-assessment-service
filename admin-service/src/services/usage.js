import { countRequest } from '../models/usageModel.js';
import { verifyToken } from '../utils/jwt.js';
import { settings } from '../config.js';

// First path segment of /api/v1/<segment> -> portal module (SaaS Usage report).
const MODULE_OF = {
    users: 'Users & Roles', roles: 'Users & Roles', branches: 'Branches / Offices', 'document-templates': 'Document Templates',
    'comm-rules': 'Communication', 'comm-templates': 'Communication', channels: 'Communication', 'comm-logs': 'Communication',
    settings: 'Claim Configuration', 'authority-matrix': 'Claim Configuration', 'approval-history': 'Claim Configuration',
    'fraud-rules': 'Fraud & Controls', triggers: 'Fraud & Controls', claims: 'Claims Management', reports: 'Reports',
    downloads: 'Data Download', changes: 'Audit Logs', 'audit-logs': 'Audit Logs', integrations: 'System Settings',
    'compliance-log': 'System Settings', system: 'System Settings',
};
export const USAGE_MODULES = [...new Set(Object.values(MODULE_OF))];

/** Express middleware: counts each API request per module and admin. Never fails a request. */
export function countUsage(req, _res, next) {
    try {
        const module = MODULE_OF[req.path.split('/')[1]];
        if (module) {
            let adminId = '';
            const [scheme, token] = (req.headers.authorization || '').split(' ');
            if (scheme === 'Bearer' && token) {
                try { adminId = verifyToken(token, settings.jwtSecret).sub ?? ''; } catch { /* unsigned: counted without admin */ }
            }
            countRequest(module, adminId);
        }
    } catch { /* counter only */ }
    next();
}
