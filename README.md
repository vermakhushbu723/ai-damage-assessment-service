# ai-damage-assessment-service

Backends of the IBima Assist car-damage insurance platform, split into two independent groups:

| Folder | What lives there |
|---|---|
| [`ai-training-backend/`](ai-training-backend/) | **AI damage assessment + model training** -- the AI ILA API (`server/`, Node, port 8000), YOLOv8 inference (`yolo-service/`, Python, port 8001), offline training + annotation (`training/`, Label Studio), architecture docs (`docs/`). Start with [`ai-training-backend/README.md`](ai-training-backend/README.md). |
| [`panel-backends/`](panel-backends/) | **Backends of the panels and apps** -- Super Admin console (`superadmin-service`, 8030), Admin portal + Pre-Inspection Agent app + IBima Assist app (`admin-service`, 8040), portal logins (`auth-service`, 8010) and field-portal claims (`claims-service`, 8020). See [`panel-backends/README.md`](panel-backends/README.md). |

Nothing is shared between the two groups: each service has its own folder, `package.json` /
`requirements.txt`, `.env`, database file and PM2 process.

Deployment (VPS, nginx, PM2, and moving an older server to this layout): [`DEPLOYMENT.md`](DEPLOYMENT.md).
