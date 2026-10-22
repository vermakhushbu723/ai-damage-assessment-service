import { db, nowIso } from '../db/database.js';
import { SERVICE_MODEL_OF_MODE } from '../constants.js';

export function getWorkflowConfig(mode) {
    const row = db.prepare('SELECT * FROM workflow_configs WHERE mode = ?').get(mode);
    return row ? { ...JSON.parse(row.config), updatedOn: row.updated_at } : null;
}

export function saveWorkflowConfig(mode, config, updatedBy) {
    const { updatedOn: _ignored, stats: _stats, ...clean } = config;
    db.prepare(`INSERT INTO workflow_configs (mode, config, updated_by, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(mode) DO UPDATE SET config = excluded.config, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(mode, JSON.stringify(clean), updatedBy ?? null, nowIso());
    return getWorkflowConfig(mode);
}

/**
 * Live numbers for the page's stat cards: roles used by enabled stages, users
 * in this mode's organizations, and how many permission switches are on.
 */
export function workflowStats(mode, config) {
    const enabled = config.rules.filter((r) => r.enabled);
    const users = db.prepare(`SELECT COUNT(*) AS n FROM users u JOIN organizations o ON o.id = u.organization_id WHERE o.service_model = ?`)
        .get(SERVICE_MODEL_OF_MODE[mode]).n;
    return {
        stages: enabled.length,
        roles: new Set(enabled.map((r) => r.role)).size,
        users,
        permissionRules: enabled.reduce((n, r) => n + (r.view ? 1 : 0) + (r.edit ? 1 : 0) + (r.approve ? 1 : 0), 0),
    };
}
