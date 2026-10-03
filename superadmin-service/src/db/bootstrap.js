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
