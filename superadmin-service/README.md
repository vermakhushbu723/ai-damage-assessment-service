# superadmin-service

Backend for the **IBima Assist Super Admin console**
(`car-damage-insurance-superadmin`, live at https://superadmin.ibimaassist.online).

Kept separate from everything else in this repo: its own folder, port (**8030**),
SQLite file (`superadmin.db`), JWT secret and PM2 process (`superadmin-service`).

| Service | Port | What it is |
|---|---|---|
| `server/` | 8000 | AI ILA backend |
| `auth-service/` | 8010 | Field-portal logins |
| `claims-service/` | 8020 | Field-portal claims |
| **`superadmin-service/`** | **8030** | **Super Admin console** |

Same stack as the other Node services: Express + Node's built-in `node:sqlite`
(Node >= 22.5, no native builds), scrypt password hashing, HS256 JWT via `node:crypto`.

## Layout

```
src/
  server.js            boot: bootstrap() then listen on 127.0.0.1:PORT
  app.js               express app, /api/v1 router, JSON error handler
  config.js            env settings
  constants.js         allowed values (org types, statuses, roles, permission matrix shape, default plans)
  db/database.js       schema (all tables)
  db/bootstrap.js      first start only: default plans, 4 system roles, 3 super admin logins
  models/              SQL per table (admin users, organizations, users + reset tokens, plans, roles, audit)
  routes/              one file per console area
  middleware/          authenticate (re-checks the admin on every request), requireMaster
  services/audit.js    writes the audit trail
  utils/               jwt, password (scrypt), ids, http helpers/validation
scripts/test-api.mjs   end-to-end API test on a throwaway database
```

## Run locally

```bash
cp .env.example .env      # set BOOTSTRAP_*_PASSWORD, or random ones are printed on first start
npm install
npm run dev               # http://127.0.0.1:8030/api/v1/health
npm run test:api          # 150+ checks, uses its own temp DB (never touches superadmin.db)
```

The console's Vite dev server (`npm run dev` in car-damage-insurance-superadmin, port 5180)
proxies `/api` here.

## Data

No sample data. On first start the service creates only:
- the plan catalog (Starter / Professional / Enterprise / Custom),
- roles: Super Admin (everything on), Organisation admin, Support admin, Reporting admin (view only),
- three console logins, all role *Super Admin*: master (`scope: all`), SaaS (`scope: saas`),
  Service Provider (`scope: serviceProvider`),
- the default claim workflow for each mode (SaaS: 10 stages, Service Provider: 7),
- the three API integrations (Policy/LOS, Vehicle/RC, Communication Gateway), *Not Configured*
  until an admin enters real endpoints,
- the running version as the first Deployment History row.

Everything else (organizations, users, admin users, service models, role/workflow changes, downloads) is created from the console; claims are pushed in by the claim systems.
Restarting never overwrites existing rows.

**Scopes.** A SaaS super admin only sees and manages SaaS organizations and their users;
a Service Provider super admin only Service Provider ones. Only the master Super Admin
(role *Super Admin* + scope *all*) can manage admin users and roles.

## API (`/api/v1`, JSON, `Authorization: Bearer <token>` unless marked public)

| Method | Path | Console screen |
|---|---|---|
| POST | `/auth/login` (public) `{ identifier: email or mobile, password }` | Login. 5 wrong passwords lock the account for 15 min |
| GET | `/auth/me` | Session refresh |
| POST | `/auth/logout`, `/auth/change-password` | |
| GET / POST | `/organizations` | Organizations/Vendors list, Create Pilot/Working ID (also creates the org admin login, returns the temp password once) |
| GET / PATCH | `/organizations/:id` | View, Edit & Modify Profile, inline Status/Subscription |
| GET | `/plans` | SaaS Plans & Subscription |
| PATCH | `/plans/:id` | Edit Plan |
| POST | `/plans/:id/assign` `{ organizationIds }` | Select Plan |
| GET / POST | `/admin-users` (POST master only) | Admin Users, + Add Admin User |
| PATCH | `/admin-users/:id` (master) | inline Role/Status/MFA |
| POST | `/admin-users/:id/reset-password` (master) | Reset an admin's password |
| GET / POST | `/users` | Users, + Add User |
| PATCH | `/users/:id` | inline Role/Status, User Activation |
| POST | `/users/bulk-status` `{ ids, status }` | User Activation bulk action |
| POST | `/users/verify` `{ userId, email, phone }` | Password Reset: Verify User |
| POST | `/users/:id/reset-link` | Password Reset: Send Link (returns a one-time link) |
| POST | `/users/:id/reset-password` `{ password, reason }` | Password Reset: Reset Manually |
| GET | `/password-reset/:token` (public) | Reset link page |
| POST | `/password-reset/confirm` (public) `{ token, password }` | Reset link page |
| GET / POST | `/roles` (POST master) | Roles & Permission, + Create Role |
| PUT | `/roles/:name/permissions` (master) | Save / Update matrix |
| DELETE | `/roles/:name` (master) | Remove an unused custom role |
| GET / POST | `/audit-logs` | Audit Logs (server writes entries for every change itself) |
| GET / POST | `/service-models` | Service Model list, Create Service Model |
| GET / PATCH | `/service-models/:id` | View / Update Service Model |
| GET | `/workflows` | Workflow Configuration (both modes for master, own mode for scoped admins; live stats) |
| PATCH | `/workflows/:mode` `{ rules?, overview?, autoRoles? }` | Save Rules / Save Configuration / Manage |
| POST | `/workflows/:mode/activate` | Activate configuration |
| POST / PATCH | `/workflows/:mode/triggers[/:id]` | Communication Triggers: Add / Edit |
| GET | `/claims`, `/claims/:id` | Dashboard, Claim Report, User Report (scoped) |
| POST | `/claims/ingest` (header `X-Service-Key`, or master token) | How claim systems push claims (create or update by claim id) |
| GET / POST | `/downloads` | Data Download history / Generate Download (CSV built on the server, kept 7 days) |
| GET | `/downloads/:id/file` | Download a generated file (410 once expired) |
| GET | `/reports/usage` | Sign-in heat map, DAU/MAU, sessions, API usage, module usage, failed-action trend, storage |
| GET | `/integrations` | System Settings > API Integration |
| PATCH | `/integrations/:id` (master) | Configure (endpoint, API key, type, environment) |
| POST | `/integrations/:id/test` | Test: real HTTP call -> Connected / Warning / Failed |
| GET | `/system` | Versions, switches, deployment history, activity table |
| PATCH | `/system/settings` (master) | Update policy, Maintenance Mode, Audit Login, retention, compliance switches |
| POST | `/system/update` (master) | Check/Update (records the deployment) |

**Claims** reach the reports through `POST /claims/ingest`. Set `CLAIMS_INGEST_KEY` in `.env`
and give it to the claim system, which sends it as `X-Service-Key`. Body:
`{ "claims": [ { "id", "organizationId", "customer", "status", "intimationDate", ... } ] }`
(`status`: Intimation | Survey | AI ILA | ILA | FLA | Settled | Rejected). Until claims are
pushed, the claim tiles, charts and tables are empty.

**System Settings behaviour:** Maintenance Mode ON = only the master Super Admin can sign in.
Audit Login OFF = sign-ins/outs are not recorded. Audit Retention deletes older audit entries
(checked on start and every 6 hours). `APP_VERSION` / `LATEST_VERSION` / `LATEST_RELEASE_DATE`
in `.env` drive the System Update card.

Errors are `{ "detail": "readable message" }` with a proper status (400 validation,
401 not signed in, 403 not allowed, 404, 409 duplicate, 423 locked).

**Email:** no mail server is configured, so "Send Link" returns the link for the admin
to share instead of emailing it (`emailSent: false`).

## Production

See `../DEPLOYMENT.md` (section "superadmin-service"). nginx proxies
`https://superadmin.ibimaassist.online/api/` to `127.0.0.1:8030`, so the console calls
its API on the same domain (no CORS, no extra DNS).
