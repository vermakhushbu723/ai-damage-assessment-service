# IBimaAssist Auth Service

Standalone login backend for `car-damage-insurance-web-app`'s four field
portals. Deliberately kept **separate** from `../server` (the AI ILA
backend) -- different folder, different port, different DB file, different
process name -- so the two are never confused with each other.

```
auth-service/
├── src/
│   ├── server.js         entrypoint -- seeds demo users, starts listening
│   ├── app.js             express app, routes, CORS, health check
│   ├── config.js          env-driven settings
│   ├── db/
│   │   ├── database.js    node:sqlite connection + schema (users table)
│   │   └── seed.js        seeds one demo login per portal
│   ├── models/
│   │   └── userModel.js   DB queries for the users table
│   ├── middleware/
│   │   └── authenticate.js  verifies the Bearer token on protected routes
│   ├── routes/
│   │   └── auth.js        POST /login, GET /me, POST /logout
│   ├── schemas/
│   │   └── roles.js       the 4 portal role constants
│   └── utils/
│       ├── password.js    scrypt hash/verify (no bcrypt/native dep)
│       └── jwt.js          hand-rolled HS256 sign/verify (no jsonwebtoken dep)
├── package.json
└── .env.example
```

## Why a "role"

Every login belongs to exactly one **role** -- `claim_workshop`,
`claim_surveyor`, `preinspection_agent`, or `preinspection_surveyor` (see
`src/schemas/roles.js`). The same username string can exist independently
under two different roles (they're different accounts); what's unique is
the pair `(role, username)` in the DB, and every issued token carries both
the user's `sub` (a UUID, unique per account) and `role` as claims. That's
the "unique key" the rest of the system uses to know who's logged in and to
keep each portal's data separate from the others -- any future table
(claims, inspections, uploaded photos, ...) can be scoped by
`(user_id, role)`.

## Setup

```bash
cd auth-service
npm install
cp .env.example .env      # adjust JWT_SECRET etc. before deploying
npm start                 # or `npm run dev` for auto-restart on change
```

On first start it seeds one demo login per portal (see
`src/db/seed.js` -- also runnable standalone via `npm run seed`):

| Portal | role | username | password |
|---|---|---|---|
| Claim Workshop | `claim_workshop` | `workshop1` | `Workshop@123` |
| Claim Surveyor | `claim_surveyor` | `surveyor1` | `Surveyor@123` |
| Pre-Inspection Agent | `preinspection_agent` | `agent1` | `Agent@123` |
| Pre-Inspection Surveyor | `preinspection_surveyor` | `presurveyor1` | `PreSurveyor@123` |

These are demo/dev credentials only -- replace with real accounts (or build
an admin "create user" screen against `src/models/userModel.js`'s
`createUser()`) before this guards anything real.

## API

### `POST /api/v1/auth/login`
```json
// request
{ "role": "claim_workshop", "username": "workshop1", "password": "Workshop@123" }

// response 200
{
  "token": "eyJhbGciOi...",
  "expiresInSeconds": 43200,
  "user": { "id": "...", "role": "claim_workshop", "username": "workshop1", "name": "Demo Claim Workshop", "createdAt": "...", "lastLoginAt": "..." }
}

// response 401 -- wrong role/username/password (same message for all three,
// so a caller can't tell which part was wrong)
{ "detail": "Invalid username or password." }
```

### `GET /api/v1/auth/me`
Header: `Authorization: Bearer <token>`. Re-checks the account is still
active in the DB (not just that the token hasn't expired) and returns the
current user. 401 if the token is missing/invalid/expired.

### `POST /api/v1/auth/logout`
Stateless tokens -- nothing to invalidate server-side. Always `{ "ok": true }`;
exists so the frontend has one consistent call instead of just dropping the
token client-side.

## Deploying alongside the AI ILA backend

Same pattern as `../server` + `../yolo-service` on the VPS (see
`../DEPLOYMENT.md`): its own PM2 process (e.g. `ibima-auth-service`), its own
`.env` with a real `JWT_SECRET` and a locked-down `CORS_ORIGINS`, and its own
nginx location/subdomain (e.g. `https://auth.ibimaassist.online` or
`https://api.ibimaassist.online/auth/...` via a path-based proxy) pointing at
its port. Not deployed yet as of this service being added -- ask before
provisioning a new subdomain/DNS record.
