// First-start setup. Creates only what the console needs to work -- the plan
// catalog, the 4 system roles and the 3 super admin logins -- and only when
// missing, so restarts never overwrite anything changed from the console.
// No sample organizations or users: those come from the console itself.

import { settings } from '../config.js';
import { DEFAULT_PLANS, SYSTEM_ROLES, MASTER_ROLE, buildPermissionMatrix } from '../constants.js';
import { countPlans, insertPlan } from '../models/planModel.js';
import { findRole, insertRole } from '../models/roleModel.js';
import { findAdminRowByIdentifier, insertAdmin } from '../models/adminUserModel.js';
import { hashPassword } from '../utils/password.js';
import { generatePassword, nextSequentialId } from '../utils/ids.js';
import { MODES, DEFAULT_WORKFLOWS, DEFAULT_INTEGRATIONS } from '../constants.js';
import { getWorkflowConfig, saveWorkflowConfig } from '../models/workflowModel.js';
import { findIntegrationRow, insertIntegration } from '../models/integrationModel.js';
import { getSystemSettings, setSystemSettings, insertDeployment, purgeOldAuditLogs } from '../models/systemModel.js';
import { purgeExpiredDownloads } from '../models/downloadModel.js';

/** Daily housekeeping: drop audit entries past the retention period, free expired download files. */
export function housekeeping() {
    const removed = purgeOldAuditLogs(getSystemSettings().retention);
    const freed = purgeExpiredDownloads();
    if (removed || freed) console.log(`[housekeeping] removed ${removed} old audit log(s), freed ${freed} expired download(s)`);
}

export function bootstrap() {
    if (countPlans() === 0) {
        DEFAULT_PLANS.forEach((p, i) => insertPlan({ ...p, sortOrder: i }));
        console.log(`[bootstrap] Created ${DEFAULT_PLANS.length} default plans.`);
    }

    for (const name of SYSTEM_ROLES) {
        if (!findRole(name)) {
            // Super Admin gets everything; the other system roles start view-only.
            const matrix = buildPermissionMatrix(name === MASTER_ROLE);
            if (name !== MASTER_ROLE) Object.values(matrix).forEach((row) => { row.view = true; });
            insertRole({ name, permissions: matrix, isSystem: true });
        }
    }

    // Claim workflow per mode (Workflow Configuration page).
    for (const mode of MODES) {
        if (!getWorkflowConfig(mode)) saveWorkflowConfig(mode, structuredClone(DEFAULT_WORKFLOWS[mode]), 'system');
    }

    // System Settings > API Integration: the three connections, unconfigured until an admin enters endpoints.
    for (const integration of DEFAULT_INTEGRATIONS) {
        if (!findIntegrationRow(integration.id)) insertIntegration(integration);
    }

    // System Update: record the running version once, so Deployment History has its first row.
    const sys = getSystemSettings();
    if (!sys.currentVersion) {
        setSystemSettings({ currentVersion: settings.appVersion });
        insertDeployment({ version: settings.appVersion, by: 'System' });
    }
    // Latest release info comes from the environment on every start.
    setSystemSettings({ latestVersion: settings.latestVersion, latestReleaseDate: settings.latestReleaseDate });

    for (const account of settings.bootstrapAdmins) {
        if (findAdminRowByIdentifier(account.email)) continue;
        const password = account.password || generatePassword(14);
        insertAdmin({
            id: nextSequentialId('admin_users', 'ADM', 100),
            name: account.name,
            email: account.email,
            phone: null,
            role: MASTER_ROLE,
            scope: account.scope,
            status: 'Active',
            mfa: false,
            passwordHash: hashPassword(password),
        });
        console.log(`[bootstrap] Created super admin ${account.email} (scope: ${account.scope})${account.password ? '' : ` -- generated password: ${password}`}`);
    }
}
