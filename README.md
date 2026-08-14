# Gjecaj Booking Engine

Hotel booking + basic PMS core for **Villa Gjecaj**, tenant-ready from day one so it
can be reused for other clients later (single tenant today).

**Stack:** NestJS 10 + TypeScript · Prisma 5 · PostgreSQL
**Modules:** `prisma` (global) · `availability` · `bookings`

## ⚠️ Local database: Neon, not Docker

Local Docker is broken on this machine — Docker Desktop 4.55.0 crashes on startup
with the *Inference manager / `dockerInference`* bug. Development therefore runs
**directly against Neon (Frankfurt / eu-central-1)**; the connection string lives in
`.env` (`DATABASE_URL`, direct connection — required for Prisma migrations).

`docker-compose.yml` stays in the repo for when Docker gets fixed — it spins up a
local Postgres 16 on port 5433 with the same schema.

## Setup

```bash
npm install
npx prisma generate
npx prisma migrate deploy   # apply schema + the anti-double-booking EXCLUDE constraint
npm run db:seed             # one tenant (Villa Gjecaj) + rooms + a season
```

`.env` is git-ignored — never commit it (it holds the Neon password).

## Run

```bash
npm run start:dev           # http://localhost:3001
```

### Endpoints
- `GET /availability?tenantId=&roomId=&checkIn=&checkOut=` → `{ available, totalPrice?, reason? }`
- `POST /bookings` → `201 { reservation }` | `409 { message: "room no longer available" }`
- `POST /bookings/:id/checkout-session` → `{ url }` (PayPal approve URL) | `404` | `409` if not pending
- `POST /webhooks/paypal` → `200 { received: true }` (raw-body signature verified; `400` on bad signature)

### Payments & lifecycle (Phase 2 — PayPal)
- **Checkout** creates a PayPal order (`POST /v2/checkout/orders`, `custom_id` = reservationId)
  using global `PAYPAL_CLIENT_ID/SECRET` (mode `PAYPAL_MODE`); returns the approve URL.
- **Webhook** (`CHECKOUT.ORDER.COMPLETED`) confirms the reservation idempotently:
  `pending → confirmed/paid` exactly once (atomic, guarded by `status='pending'`),
  then sends the confirmation email. Duplicate PayPal retries change nothing.
  `CHECKOUT.ORDER.APPROVED` triggers a capture. Signature verified offline
  (RSA-SHA256 over `transmissionId|time|webhookId|crc32(body)`); needs `PAYPAL_WEBHOOK_ID`.
- **Pending expiry cron** (`@Cron`, every minute) flips overdue `pending` holds to
  `expired`, which frees the dates automatically (they leave the EXCLUDE guard).
- **Email** via `EmailService` (Resend if `RESEND_API_KEY` set, else console log).
  `from` address comes from `tenant_settings.email_from`.

## Test

```bash
npm run test:e2e            # real HTTP concurrency test: 10 parallel bookings -> 1×201, 9×409
```

## Anti-double-booking

A Postgres `EXCLUDE USING gist` constraint (needs `btree_gist`) blocks overlapping
`pending`/`confirmed` date ranges per room at the database level. It's added via raw
SQL in the init migration (Prisma can't express it). The real race guard is catching
SQLSTATE `23P01` on INSERT and returning 409 — not the pre-check.

## Admin UI (Phase 3)

Server-rendered (Handlebars) under `/admin/*`, protected by **temporary** single-admin
HTTP Basic Auth (`ADMIN_USER` + bcrypt `ADMIN_PASSWORD_HASH`). It only surfaces
existing data/logic — no new business rules. Pages:
- `GET /admin/reservations` — list with status + date-range filters (default: next 30 days)
- `GET /admin/calendar?month=&year=` — monthly grid, one row per room, cells colored by status
- `GET /admin/rooms` — CRUD (`POST` / `PUT` / `DELETE`); deleting a room with active
  (pending/confirmed) reservations is **blocked**, not cascaded
- `GET /admin/seasons` — CRUD; **warns** (does not block) when seasons overlap for a room type

> ⚠️ Basic Auth is a stopgap for one operator. When a 2nd client is onboarded,
> replace it with a per-tenant `admins` DB table (see `src/admin/basic-auth.ts`).

## Beds24 bridge (Phase 4)

Sync layer over the existing services/constraint — no new booking rules. Beds24
API v2 (`https://api.beds24.com/v2`), auth via a per-tenant refresh token
(`tenant_settings.beds24_api_key`) exchanged for short access tokens.
- **Direction 1 (OTA → us):** `POST /webhooks/beds24` imports a Booking.com/Airbnb
  booking as `source=beds24`, `confirmed/paid`, keyed by `external_booking_id`
  (idempotent). It passes the **same** EXCLUDE constraint; a `23P01` conflict = a
  real cross-channel double-booking → logged as `error` + admin email, never
  swallowed. Unmapped Beds24 room → logged, skipped. Optional `?token=` shared secret.
- **Direction 2 (us → OTA):** when a direct booking is confirmed, `POST /bookings`
  to Beds24 blocks those dates on the OTAs. **Best effort** — failure is logged for
  retry and never blocks the (already paid) local booking.
- **Availability** still reads only the local DB; Beds24 keeps the DB current, it
  is not queried live per public search.

Room mapping: `rooms.beds24_room_id`; property id: `tenant_settings.beds24_prop_id`.

## Payment mode

`tenant_settings.payment_mode` controls direct bookings:
- `on_arrival` (default): `POST /bookings` confirms the reservation immediately
  (guest pays at the property), sends the confirmation email, and pushes the
  block to the OTAs. No online payment, no pending hold.
- `prepaid`: booking is held `pending` until an online payment confirms it
  (the PayPal flow / a future gateway). Flip per tenant when a gateway is wired.

## Deploy

Container image (`Dockerfile`) runs `prisma migrate deploy` then starts the app;
binds `0.0.0.0:$PORT`. Works on Render/Railway/Fly/VPS. Required env vars:

- `DATABASE_URL` (Neon, direct connection)
- `APP_PUBLIC_URL` (the frontend origin, for payment return URLs)
- `ADMIN_USER`, `ADMIN_PASSWORD_HASH` (bcrypt)
- `RESEND_API_KEY` (optional; console fallback if unset)
- `BEDS24_WEBHOOK_SECRET` (optional shared secret for `/webhooks/beds24`)
- Payment (only if `payment_mode=prepaid`): `PAYPAL_CLIENT_ID/SECRET/MODE/WEBHOOK_ID`

The frontend (gjecaj.al on Vercel) calls this service via its BFF; set
`BOOKING_ENGINE_URL` + `BOOKING_TENANT_ID` there.

## Phase status
- **Phase 1 — done:** schema, migration, availability + booking services, endpoints, concurrency test.
- **Phase 2 — done (PayPal):** PayPal checkout, idempotent webhook, pending-expiry cron, confirmation email; end-to-end test.
- **Phase 3 — done:** minimal admin UI (reservations, calendar, rooms/seasons CRUD, auth) + tests.
- **Phase 4 — done:** Beds24 two-way sync; live auth verified.
- **Direct bookings — pay-on-arrival** (default); online payment is a drop-in when a gateway is chosen.
