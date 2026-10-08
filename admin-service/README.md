# admin-service

Backend for the **IBima Assist Admin portal**
(`car-damage-insurance-admin`, the insurer's admin console at https://admin.ibimaassist.online).

Kept separate from everything else in this repo: its own folder, port (**8040**),
SQLite file (`admin.db`), JWT secret and PM2 process (`admin-service`).

| Service | Port | What it is |
|---|---|---|
| `server/` | 8000 | AI ILA backend |
| `auth-service/` | 8010 | Field-portal logins |
| `claims-service/` | 8020 | Field-portal claims |
| `superadmin-service/` | 8030 | Super Admin console |
| **`admin-service/`** | **8040** | **Admin portal** |

Same stack as the other Node services: Express + Node's built-in `node:sqlite`
(Node >= 22.5, no native builds), scrypt password hashing, HS256 JWT via `node:crypto`.

## Layout

```
src/
  server.js              boot: bootstrap() then listen on 127.0.0.1:PORT
  app.js                 express app, /api/v1 router, JSON error handler
  config.js              env settings
  constants.js           allowed values (same lists as the portal's dropdowns)
  db/database.js         schema (all tables)
  db/defaults.js         starting configuration: roles, rule sets, templates, switches (no sample data)
  db/bootstrap.js        first start only: admin login + defaults; housekeeping (retention, expired files)
  models/                SQL per table (admins, users, roles, records, settings, claims, audit, downloads, usage)
  routes/                one file per portal area; resources.js = the generic configuration lists
  middleware/            authenticate (re-checks the admin on every request), X-Service-Key
  services/              audit trail, request counting, integrations / Communication Gateway
  utils/                 jwt, password (scrypt), ids, csv, http helpers/validation
scripts/test-api.mjs     end-to-end API test on a throwaway database
```

## Run locally

```bash
cp .env.example .env      # set BOOTSTRAP_ADMIN_PASSWORD, or a random one is printed on first start
npm install
npm run dev               # http://127.0.0.1:8040/api/v1/health
npm run test:api          # 150+ checks, own temp DB + mock external API (never touches admin.db)
```

The portal's Vite dev server (`npm run dev` in car-damage-insurance-admin, port 5200)
proxies `/api` here.

## Data

No sample data. On first start the service creates only configuration:
the admin login, 11 roles with their permission matrix, the dashboard / claim-flow /
approval / fraud-routing / recommendation / stage-TAT / system / compliance settings,
the communication rules + templates + 4 channels, 10 document templates, 4 fraud rules,
the authority matrix, 3 integrations (*Not Configured*) and the first deployment row.
Each part is written once -- a list the admin empties is not refilled on restart.

Users, branches, changes, audit events and downloads are created from the portal;
**claims, fraud triggers and communication logs** come from the claim systems through
`POST /claims/ingest`. Until they push data, the claim tiles, charts and tables are empty.

## API (`/api/v1`, JSON, `Authorization: Bearer <token>` unless marked public)

| Method | Path | Portal screen |
|---|---|---|
| POST | `/auth/login` (public) `{ identifier: email or mobile, password }` | Login. 5 wrong passwords lock the account for 15 min |
| GET | `/auth/me` · POST `/auth/logout`, `/auth/change-password` | Session |
| GET / POST | `/users` | User Activation, dashboard counts / Create Users (returns `tempPassword` once; only its hash is stored) |
| GET / PATCH | `/users/:id` | Modify user, inline status, capacity limit (`capacityLimit`) |
| POST | `/users/bulk-status` `{ ids, status }` | User Activation |
| POST | `/users/verify` `{ userId, email, contact }` | Password Reset: Verify User |
| POST | `/users/:id/reset-link` | Password Reset: Send Link (returns a one-time link; no mail server) |
| POST | `/users/:id/reset-password` | Password Reset: Reset Manually (returns a temp password once) |
| GET / POST | `/password-reset/:token`, `/password-reset/confirm` (public) | The page a reset link opens |
| GET / POST · PATCH / DELETE | `/roles` · `/roles/:key` | Roles & Permissions, Create Users > Add Role |
| GET · GET/PUT | `/settings` · `/settings/:key` | Dashboard switches, Claim Journey, Approval Logic rules, Fraud Routing, Recommendation Engine, Stage TAT, System Update switches, Audit & Compliance |
| GET / POST / PATCH / DELETE | `/branches`, `/document-templates`, `/comm-rules`, `/comm-templates`, `/fraud-rules`, `/authority-matrix` | Configuration lists (delete where the screen has it) |
| GET / PATCH | `/channels` (+ `sentToday`), POST `/channels/:id/test` | Communication Setup > Channels |
| GET · POST | `/comm-logs` · `/comm-logs/:id/retry` | Communication Logs, Retry |
| GET / PATCH | `/triggers` | Trigger History (status, reviewer) |
| GET / POST | `/approval-history`, `/compliance-log` | Append-only; date and user stamped by the server |
| GET | `/claims`, `/claims/:id` | Claim / User Report, Allocation, Recommendation, Fraud |
| POST | `/claims/ingest` (header `X-Service-Key`, or an admin token) | How claim systems push `{ claims, triggers, commLogs }` (create or update by id) |
| POST | `/claims/reassign` `{ fromHandlerId, toHandlerId, count }` | Allocation Load: Reasigned |
| GET / POST | `/changes` | Recent Configuration Changes (who / when / device stamped by the server) |
| GET | `/audit-logs` | Audit Logs: sign-ins, failed sign-ins, resets, exports, downloads |
| GET / POST | `/downloads` `{ format, types, from, to, region? }` | Data Download (CSV / Excel / JSON built on the server, kept 7 days) |
| GET | `/downloads/:id/file` | Download a generated file (410 once expired) |
| GET | `/reports/usage` | SaaS Usage (cards, DAU/MAU, module usage) + User Report heat map |
| GET / PATCH · POST | `/integrations` · `/integrations/:id/test` | System Settings > API Integration (real HTTP test; API key never returned) |
| GET · POST | `/system` · `/system/update` | System Update (versions from `.env`, deployment history) |

Errors are `{ "detail": "readable message" }` with a proper status (400 validation,
401 not signed in, 404, 409 duplicate, 410 expired file, 423 locked, 502 gateway error).

**Claims ingest** body (fields other than `id` / `stage` optional):
`{ "claims": [{ "id", "customer", "type", "handlerId", "amount", "slaDays", "tatMinutes", "stage", "branchId", "region", "intimatedAt", "vehicleNo" }],
"triggers": [{ "id"?, "claim", "trigger", "score", "route", "reviewer", "status" }],
"commLogs": [{ "id"?, "claim", "communication", "recipient", "to", "channel", "status", "message" }] }`.
`handlerId` / `branchId` are the portal's own user / branch ids (USR-…, BR-…).

**Messages** ("Send Test", "Retry") go to the Communication Gateway integration
(System Settings): `POST <endpoint> { channel, to, recipient, message, claim, reference }`
with the API key as Bearer / X-API-Key. Nothing is marked delivered unless it answers 2xx.

**Email:** no mail server is configured, so "Send Link" returns the link for the admin
to share (`emailSent: false`).

## Production

See `../DEPLOYMENT.md` (section "admin-service"). nginx proxies
`https://admin.ibimaassist.online/api/` to `127.0.0.1:8040`.
