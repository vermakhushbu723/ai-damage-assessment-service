# IBimaAssist Claims Service

Backend for `car-damage-insurance-web-app`'s claim data -- the Owner &
Vehicle Details form creates a claim here, and each portal's Dashboard
lists its own claims from here. Kept **separate** from `../server` (AI ILA
backend) and `../auth-service` (login backend) -- own folder, own port
(8020), own SQLite DB (`claims.db`).

```
claims-service/
├── src/
│   ├── server.js         entrypoint -- seeds sample data, starts listening
│   ├── app.js             express app, routes, CORS, health check
│   ├── config.js          env-driven settings
│   ├── db/
│   │   ├── database.js    node:sqlite connection + schema (claims table)
│   │   └── seed.js        seeds sample claim_workshop claims
│   ├── models/
│   │   └── claimModel.js  DB queries + DB-row -> API-shape mapping
│   ├── middleware/
│   │   └── authenticate.js  verifies the Bearer token (see below)
│   ├── routes/
│   │   └── claims.js      POST /claims, GET /claims
│   └── utils/
│       └── jwt.js          verify-only copy of auth-service's HS256 logic
├── package.json
└── .env.example
```

## Auth

Every route requires `Authorization: Bearer <token>` -- the same token
`../auth-service`'s `POST /api/v1/auth/login` issues. This service verifies
it locally (no network call to auth-service) using the same `JWT_SECRET`,
so **`.env`'s `JWT_SECRET` here must exactly match `../auth-service/.env`'s**.

Every claim is scoped by the token's `role` claim:
- `POST /api/v1/claims` stamps the new claim's `role`/`created_by_*` from
  the token -- never from the request body, so one portal can't create a
  claim under another portal's name.
- `GET /api/v1/claims` only ever returns claims whose `role` matches the
  caller's token. A `claim_surveyor` login can never see a `claim_workshop`
  claim through this API, and vice versa -- this is the actual
  data-separation-by-portal-type mechanism, not just a UI-level filter.

## Setup

```bash
cd claims-service
npm install
cp .env.example .env
# Edit .env: JWT_SECRET must match ../auth-service/.env's JWT_SECRET exactly.
npm start          # or `npm run dev`
```

On first start it seeds 6 sample claims for the `claim_workshop` portal
(also runnable standalone via `npm run seed`) -- so `workshop1`'s Dashboard
has real data immediately instead of an empty list.

## API

### `POST /api/v1/claims`
Body = the Owner & Vehicle Details form:
```json
{
  "ownerName": "Rahul Sharma", "mobile": "9876543210", "email": "rahul@example.com",
  "odometer": "18500", "registrationNumber": "OD02AB1234", "state": "Odisha",
  "registrationDate": "12-03-2022", "product": "Private Car", "make": "Maruti Suzuki",
  "model": "Swift Dzire", "variant": "Z4", "manufacturingYear": "04-2022"
}
```
Response `201`: `{ "claim": { "id", "claimNumber", "insurerName", "insuredName", "registrationNumber", "status": "Pending", "vehicle", "surveyDate": null, "location", "amount": null, ... } }`

### `GET /api/v1/claims` (optional `?status=Pending|Completed`)
Response `200`: `{ "claims": [...], "counts": { "total": N, "completed": N, "pending": N } }` --
`counts` always reflects **all** of this portal's claims regardless of the
`status` filter (matches the Dashboard's stat cards).

## Deploying alongside the AI ILA + auth backends

Same pattern as `../server` + `../yolo-service` + `../auth-service` on the
VPS: its own PM2 process (e.g. `ibima-claims-service`), its own `.env` with
a real `JWT_SECRET` **matching `auth-service`'s**, a locked-down
`CORS_ORIGINS`, and its own nginx location/subdomain. Not deployed yet as
of this service being added.
