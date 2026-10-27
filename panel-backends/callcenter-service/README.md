# callcenter-service

Backend of the **Call Center / Claim Management portal** (`car-damage-insurance-callcenter`,
https://cms.ibimaassist.online). Express + built-in `node:sqlite`, port **8050**, own
`callcenterServiceProvider.db` and `uploads/`, PM2 name `callcenter-service`.

## Who signs in

Nobody is created here. Users are made in the **Admin portal > Create Users**
(admin-service). This service asks admin-service (`/api/v1/internal/*`, header
`X-Service-Key` = admin-service `CLAIMS_INGEST_KEY`) to check the password, and
re-checks the account every `USER_CACHE_SECONDS`:

- status must be **Active**, platform **web** or **both**;
- surveyor / pre-inspection roles use the mobile apps and are refused;
- the role's **Roles & Permissions** matrix decides which screens and actions
  work (e.g. *Call Center* = Dashboard, Intimation, Communication only; *Claim
  Handler* = the whole claim journey). The API enforces it, the portal hides the rest.
- first sign-in with a temp password asks for a new one.

## Claim journey

Intimation (draft -> submit) -> Handler Allocation -> Surveyor Assignment ->
Claim Details -> AI ILA -> FLA (Handler ILA) -> Payment Recommendation -> Survey Paybill.

On submit the claim goes to admin-service `POST /claims/ingest`; the Admin
portal's allocation rule picks the handler and it is copied back. Every stage
change, handler change and communication is pushed again (queued in `outbox`,
retried every minute if admin-service is down).

Handlers, surveyors and approvers are the Admin users with roles
`claim-handler`, `internal-surveyor` / `external-surveyor`, `state-manager` / `regional-manager` / `national-manager`.

## Outside systems (optional)

| Setting | Without it |
|---|---|
| `NOTIFY_WEBHOOK_URL` (SMS / Email / WhatsApp gateway) | messages are logged with status **Pending**, nothing is delivered |
| `AI_SERVICE_URL` (ai-training-backend/server: detect, assess, corrections) | AI ILA shows "AI not connected"; reviewers add damages by hand |

## Run

```bash
npm install
cp .env.example .env   # set ADMIN_SERVICE_KEY = admin-service CLAIMS_INGEST_KEY
npm start
npm run test:api       # starts admin-service + this service on throwaway DBs (141 checks)
```

## API (all under `/api/v1`, Bearer token from `/auth/login`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/change-password` |
| Dashboard | `GET /dashboard?range=&all=1&priority=&source=&from=&to=&location=&insurer=&page=&allocationPage=`, `GET /dashboard/analytics?days=7\|30` (Analyze Data), public `GET /s/:token` (survey link, counts opens) |
| Claims | `GET /claims`, `GET /claims/next-id`, `POST /claims` (draft), `GET/PATCH /claims/:id`, `POST /claims/:id/submit`, `POST /claims/:id/survey-link` |
| Action bar | `GET/POST /claims/:id/remarks`, `GET /claims/:id/audit` |
| Handler | `GET /handlers`, `GET/POST /claims/:id/handler` |
| Surveyor | `GET /surveyors`, `GET/POST /claims/:id/surveyors`, `POST /claims/:id/surveyors/:aid/cancel` |
| Claim details | `GET/PUT /claims/:id/details` (vehicle / driver / loss / vahan), `GET/PUT /claims/:id/info` (Claim Information, 12 tabs), `POST /claims/:id/unique-id` |
| Documents DMS | `GET /claims/:id/documents`, `PUT /claims/:id/documents/:type` (raw file, `X-File-Name`), `POST /claims/:id/documents/process`, `GET .../documents/download.zip`, `GET .../documents/download.pdf`, `GET /files/:docId?exp&sig` (signed) |
| AI ILA | `GET /claims/:id/ai-ila`, `POST .../run`, `PATCH/DELETE .../items/:itemId`, `POST .../items`, `POST .../items/merge`, `POST .../approve-all`, `PUT .../note`, `POST .../decision`, `POST .../report`, `GET .../report.pdf`, `GET .../export.csv` |
| Handler ILA / FLA | `GET /claims/:id/liability` (HANDLER ILA) and `/claims/:id/fla` (FLA, seeded from Handler ILA; its submit completes the FLA step): `POST/PATCH .../parts`, `PUT .../charges`, `POST .../report` (PDF), `POST .../submit` |
| Payment | `GET/PUT /claims/:id/payment`, `POST /claims/:id/payment/submit` |
| Paybill | `GET/PUT /claims/:id/paybill`, `POST /claims/:id/paybill/pdf` |
| Letters | `GET/POST /claims/:id/letters`, `POST .../letters/preview.pdf`, `GET .../letters/:letterId/pdf` |
| Communication | `GET/POST /claims/:id/communications` (email / sms / note / response), `GET .../communications/export.csv` |
