# panel-backends

Node.js (>= 22.5, built-in `node:sqlite`) backends for the IBima Assist panels and apps.
No AI or training code here -- that is in [`../ai-training-backend`](../ai-training-backend/).

| Service | Port | PM2 name | Used by |
|---|---|---|---|
| [`superadmin-service`](superadmin-service/README.md) | 8030 | `superadmin-service` | Super Admin console (`car-damage-insurance-superadmin`) -- https://superadmin.ibimaassist.online/api |
| [`admin-service`](admin-service/README.md) | 8040 | `admin-service` | Admin portal (`car-damage-insurance-admin`), Pre-Inspection Agent app (`/api/v1/field`), IBima Assist app enquiries (`/api/v1/public`), Documents DMS -- https://admin.ibimaassist.online/api |
| [`callcenter-service`](callcenter-service/README.md) | 8050 | `callcenter-service` | Call Center / Claim Management portal (`car-damage-insurance-callcenter`) -- https://cms.ibimaassist.online/api. Users = Admin > Create Users (via admin-service `/api/v1/internal`), claims pushed to admin-service `/claims/ingest` |
| [`auth-service`](auth-service/README.md) | 8010 | -- | Logins of the web app's field portals (claim workshop / surveyor, pre-inspection agent / surveyor) |
| [`claims-service`](claims-service/README.md) | 8020 | -- | Claims of those field portals (shares `auth-service`'s `JWT_SECRET`) |

Each one is self-contained: `cd <service> && npm install && cp .env.example .env && npm start`.
Its database file, `.env` and `uploads/` stay inside its own folder.
