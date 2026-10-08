import { db, nowIso } from '../db/database.js';

// The API key is write-only: responses only say whether one is set.
const toDto = (r) => r && ({
    id: r.id,
    name: r.name,
    description: r.description,
    type: r.type,
    environment: r.environment,
    endpoint: r.endpoint,
    hasApiKey: Boolean(r.api_key),
    status: r.status,
    responseMs: r.last_response_ms,
    lastError: r.last_error,
    lastSync: r.last_sync,
    updatedOn: r.updated_at,
});

export const listIntegrations = () => db.prepare('SELECT * FROM integrations ORDER BY rowid').all().map(toDto);
export const findIntegrationRow = (id) => db.prepare('SELECT * FROM integrations WHERE id = ?').get(id);
export const findIntegration = (id) => toDto(findIntegrationRow(id));

export function insertIntegration(i) {
    db.prepare('INSERT INTO integrations (id, name, description, type, environment, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(i.id, i.name, i.description ?? null, i.type, i.environment, 'Not Configured', nowIso());
}

const COLUMNS = {
    endpoint: 'endpoint', apiKey: 'api_key', type: 'type', environment: 'environment', status: 'status',
    responseMs: 'last_response_ms', lastError: 'last_error', lastSync: 'last_sync',
};

export function updateIntegration(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
        if (patch[key] === undefined) continue;
        sets.push(`${column} = ?`);
        values.push(patch[key]);
    }
    if (sets.length) db.prepare(`UPDATE integrations SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
    return findIntegration(id);
}
