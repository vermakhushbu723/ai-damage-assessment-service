# ai-damage-assessment-service

Backends of the IBima Assist car-damage insurance platform, split into two independent groups:

| Folder | What lives there |
|---|---|
| [`ai-training-backend/`](ai-training-backend/) | **AI damage assessment + model training** -- the AI ILA API (`server/`, Node, port 8000), YOLOv8 inference (`yolo-service/`, Python, port 8001), offline training + annotation (`training/`, Label Studio), architecture docs (`docs/`). Start with [`ai-training-backend/README.md`](ai-training-backend/README.md). |
| [`panel-backends/`](panel-backends/) | **Backends of the panels and apps** -- Super Admin console (`superadmin-service`, 8030), Admin portal + Pre-Inspection Agent app + IBima Assist app (`admin-service`, 8040), Call Center portal (`callcenter-service`, 8050), portal logins (`auth-service`, 8010) and field-portal claims (`claims-service`, 8020). See [`panel-backends/README.md`](panel-backends/README.md). |

Nothing is shared between the two groups: each service has its own folder, `package.json` /
`requirements.txt`, `.env`, database file and PM2 process.

## Database files (Service Provider edition)

Every service stores its data in its own SQLite file (`node:sqlite`, not MongoDB). The files carry
the `ServiceProvider` name so they are never mixed up with the SaaS edition's copies:

| Service | Database file |
|---|---|
| `panel-backends/superadmin-service` | `superadminServiceProvider.db` |
| `panel-backends/admin-service` | `adminServiceProvider.db` |
| `panel-backends/callcenter-service` | `callcenterServiceProvider.db` |
| `panel-backends/auth-service` | `authServiceProvider.db` |
| `panel-backends/claims-service` | `claimsServiceProvider.db` |
| `ai-training-backend/server` | `aiDamageAssessmentServiceProvider.db` |

`DATABASE_FILE`, `UPLOADS_DIR` and `.env` itself are resolved from the service's own folder, so a
service behaves the same whichever directory it is started from.

**Upgrading a server that still has the old names** (`admin.db`, `superadmin.db`, `callcenter.db`,
`auth.db`, `claims.db`, `ai_damage_assessment.db`): on its first start each service renames its old
file (plus `-wal` / `-shm`) to the new name, provided the new file does not exist yet and `.env` does
not pin `DATABASE_FILE` to the old name. Update backup scripts to the new names.

Deployment (VPS, nginx, PM2, and moving an older server to this layout): [`DEPLOYMENT.md`](DEPLOYMENT.md).
