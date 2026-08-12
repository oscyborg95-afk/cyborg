# Cyborg OS — Daily Cart Command Center

Unified omnichannel workspace for a solo operator running a WhatsApp COD funnel in
Sri Lanka. The entire business runs on one screen: live WhatsApp inbox, AI address
parsing, one-click courier dispatch, and a gamified high-score board.

## Routes

| Route | What it is |
|---|---|
| `/` | **Three-panel workspace** — searchable inbox (`/` to search, `j`/`k` to move) with triage filters and a follow-up queue for chats stuck mid-order, live chat with a state-aware quick-action bar, and the logistics copilot (parse from chat → COD risk check → dispatch → auto-message the customer) |
| `/orders` | Manual fallback flow (paste → parse → book → copy), order status bookkeeping, courier invoice upload and net-payout reconciliation, returned-order redelivery flow, CSV export |
| `/attention` | **Attention Center** — ranked unreplied leads, stalled confirmations, AI handoffs, ready-to-dispatch orders, and delivery problems |
| `/customers` | Customer 360 directory with lifetime value, delivery history, AI memory, language, tags, notes, and per-customer autonomy controls |
| `/ai` | Autonomous salesperson control room — off/draft/auto mode, knowledge, tone, confidence threshold, quiet hours, and full decision audit |
| `/broadcast` | Rate-limited WhatsApp blast to past customers (launches/restocks) |
| `/analytics` | High-score board — levels, dispatch streak, net worth — plus return rates by district/product and an ad-spend/ROAS tracker |
| `/login` | Operator login (only when `APP_PASSWORD` is set) |

## Setup

1. `cp .env.local.example .env.local` and set `GEMINI_API_KEY` (required for parsing —
   free key from https://aistudio.google.com/apikey; `ANTHROPIC_API_KEY` also works as a fallback).
2. **WhatsApp worker** (`worker/`): `cd worker && npm install`, then either
   - `npm run mock` — seeded fake chats, no WhatsApp needed (great for testing), or
   - `npm start` — real WhatsApp session via Baileys (direct WebSocket, no browser
     needed). Scan the QR once at http://localhost:3001/qr — or just open the
     Workspace at :3000, which shows it inline. With `DATABASE_URL` set the session
     is stored in Postgres, so restarts and redeploys never need a re-scan.
   The worker calls `APP_URL/api/agent/inbound` for autonomous replies. In
   production set the same strong `AGENT_WEBHOOK_SECRET` on the web app and worker.
   `npm start` now runs the multi-tenant supervisor. It reads active tenants from
   Postgres and starts one isolated Baileys child connection per tenant. Use
   `npm run start:single` only for legacy/local single-account troubleshooting.
3. Supabase/Postgres: run `supabase/schema.sql` in the SQL editor. The legacy
   single-workspace development mode can use an in-memory store, but multi-tenant
   accounts require `DATABASE_URL`; `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` are optional server-side client settings.
4. Optional — courier: set `COURIER_API_URL` / `COURIER_API_KEY` and adjust the payload
   field names in `lib/couriers.ts` to your courier's docs. Mock tracking IDs otherwise.
5. `npm run dev` and open http://localhost:3000.

### Multi-tenancy

Set `DATABASE_URL`, `SESSION_SECRET`, `WORKER_API_SECRET`, and `ADMIN_EMAIL` in
both deployments as applicable. On the first login, the former single-operator
workspace is registered as the legacy tenant using the existing `APP_PASSWORD`.
New accounts are created at `/login` when `ALLOW_SIGNUP=true`.

Each new tenant receives its own PostgreSQL schema. All existing orders, CRM,
settings, products, AI state, WhatsApp credentials, chats, messages, and media
queries run through a pool whose `search_path` is fixed to that authenticated
tenant's schema. The browser's worker token is signed with the tenant ID, and
Socket.IO uses `/t/<tenant-id>/socket.io`, preventing a token issued for one
workspace from reaching another tenant's WhatsApp process.

The deployed worker is one supervisor, not one deployment per customer:

```text
worker/manager.js
  ├─ tenant A child (Baileys socket A, schema A)
  ├─ tenant B child (Baileys socket B, schema B)
  └─ tenant C child (Baileys socket C, schema C)
```

The supervisor polls `public.app_tenants`; signup therefore starts a new child
automatically without redeployment. `WA_MAX_TENANTS` is a hard capacity guard.
Measure memory before raising it: the current Google Cloud `e2-micro` is suitable
for the legacy account but should be upgraded before promising three concurrent
production accounts.

### Tracking reliability

Set `COURIER_WEBHOOK_SECRET` for the TransExpress callback and `CRON_SECRET`
for the protected tracking fallback runner.

`/api/tracking/cron` takes a `mode`:

| Mode | Cost | What it does |
| --- | --- | --- |
| `?mode=sync` | one courier round trip per in-flight parcel | full reconciliation of courier history, then drains the outbox |
| `?mode=drain` | one DB round trip | flushes the WhatsApp outbox only |

The drain matters on its own because reminders are queued for a wall-clock time
— the owner's 07:00 "delivery today" nudge sits in the queue until something
drains it. Run it every few minutes; a sync-only schedule delivers 07:00
reminders at whatever hour the sync happens to run.

`vercel.json` ships Hobby-compatible daily schedules for both. **On Vercel Pro,
change them to `0 * * * *` (sync) and `*/15 * * * *` (drain).** On any plan, the
always-on WhatsApp worker drives both on a much tighter loop — drain every two
minutes, sync every ten — when you set Railway worker variables
`APP_TRACKING_CRON_URL=https://cyborg-fawn.vercel.app/api/tracking/cron` and the
same `CRON_SECRET` value used by Vercel. Tune with `TRACKING_DRAIN_INTERVAL_MS`
and `TRACKING_SYNC_INTERVAL_MS`.

A sync reports `remaining` when it hits `TRACKING_SYNC_BUDGET_MS` (45s default)
before walking every parcel. Parcels are polled least-recently-updated first, so
the next run resumes with the stale ones — a `remaining` that never falls means
the schedule is too slow for the shop's volume.

### Not talking over yourself

Courier events arrive twice — once by webhook, once by the poller — and the two
disagree about attempt numbers and dates. Three layers keep that from becoming
duplicate customer messages:

1. Both paths build the event through one normalizer (`lib/delivery-events.ts`).
2. The customer's dedupe key is order + delivery date, never the attempt number.
3. `CUSTOMER_NOTIFICATION_COOLDOWN_HOURS` (12 by default) collapses repeats of
   the same message type to one per order per window. Owner alerts are exempt —
   the operator wants every revision.

Every message an order caused is listed under "Messages sent for this order" in
the delivery rescue card, with its dedupe key and outcome.

## Architecture

```
[ WhatsApp ] ⇄ worker/ (Baileys + Socket.io, :3001) ⇄ Next.js UI (:3000)
                                                          │
                          ┌───────────────────────────────┼───────────────┐
                          ▼                               ▼               ▼
              [ AI parsing (Gemini) ]        [ Supabase / in-memory ]  [ Courier API ]
```

| Piece | Where |
|---|---|
| Headless WhatsApp worker (Baileys, mock + live modes, Postgres-backed session, voice-note/photo capture) | `worker/index.js` |
| Worker proxy + send API | `lib/wa.ts`, `app/api/whatsapp/*` |
| AI parsing engine (Gemini free tier, structured JSON; Claude fallback) — reads chat text **and** voice notes / address photos | `lib/parse.ts`, `app/api/parse/route.ts` |
| COD risk scoring (per-phone delivery history) | `lib/risk.ts` |
| Follow-up queue (stale AWAITING_* chats → one-tap Sinhala nudge) | `app/page.tsx`, templates `followUpAddress` / `followUpConfirm` |
| Full-history tracking reconciliation (attempts, reschedules, delivered / terminal return) | `app/api/track/sync/route.ts`, `lib/delivery-events.ts` |
| Real-time courier webhooks feeding the same delivery-event workflow | `app/api/courier/webhook/route.ts`, `lib/delivery-workflow.ts` |
| Delivery rescue queue, previous-day/morning owner reminders, retryable WhatsApp outbox | `lib/db.ts`, `lib/tracking-notifications.ts`, `app/orders/page.tsx` |
| Cash reconciliation (XLSX invoice → gross COD, fees, commission, VAT/tax, actual bank receipt, variance) | `app/api/remittance/route.ts`, Orders page |
| Return workflow (redeliver offer + one-click re-book) | `app/api/orders/[id]/rebook/route.ts` |
| Ad spend + ROAS (manual daily entry, delivered-revenue attribution) | `app/api/adspend/route.ts`, Quest page |
| Broadcast (rate-limited, past customers only) | `app/broadcast/page.tsx` |
| Operator auth gate (`APP_PASSWORD`) | `proxy.ts`, `lib/auth.ts`, `app/login` |
| One-click dispatch (book + track + auto-message + state) | `app/api/dispatch/route.ts` |
| Chat state machine (drives the dynamic action bar) | `lib/db.ts`, `app/api/chat-state/route.ts` |
| Autonomous AI salesperson (catalog-grounded decisions, multilingual replies, confidence gates, handoff) | `lib/sales-agent.ts`, `lib/agent-runtime.ts`, `app/api/agent/*` |
| Customer 360, AI memory, event history, and decision audit | `lib/crm-db.ts`, `lib/customers.ts`, `app/api/customers/*` |
| Ranked Attention Center (sales, AI, and delivery exceptions) | `lib/attention.ts`, `app/api/attention/*` |
| Message templates (Sinhala) | `lib/templates.ts` |
| Gamified metrics (levels, streak, net worth) | `lib/metrics.ts`, `app/api/metrics/route.ts` |
| Products + physical stock (presets, auto restock on returns) | `app/api/products/*`, managed on `/analytics` |
| Courier tracking auto-sync (booked → delivered/returned) | `lib/couriers.ts`, `app/api/track/sync/route.ts` |
| Orders + manifests data layer (tenant Postgres schemas; in-memory for legacy local development only) | `lib/db.ts`, `supabase/schema.sql` |
| Courier REST bridge (mock mode until keys are set) | `lib/couriers.ts` |

## The dispatch loop

1. Customer message lands in the inbox in real time (Socket.io push from the worker).
2. Open the chat → click **Parse address from chat** — the last customer messages go to
   the LLM and the form fills itself.
3. Set the product price → **DISPATCH**. One click: books the courier, stores the
   tracking ID, marks the chat SHIPPED, and auto-sends the Sinhala confirmation.
4. Tracking syncs itself: the workspace re-checks each parcel's complete courier
   history every 10 minutes (and `/orders` on every visit). It reconstructs
   delivery attempt numbers, extracts `Reschedule Date` from courier remarks,
   auto-messages the customer and owner, and creates a call task in the Orders
   **Delivery rescue** panel. A future re-attempt schedules an owner reminder at
   6 PM the previous day and again on delivery morning if the call is unresolved.
   Only `Delivered` and `Returned to HO` finalize the order; branch reschedules
   never restock it. A cron can also drive the same flow: `POST /api/track/sync`.
5. When the Friday courier payout lands, upload its `InvoiceDetails.xlsx` on `/orders`,
   verify delivery/commission/VAT deductions, enter the actual bank receipt, and record it.
   Bank cash increases by the actual net receipt—not gross COD. Disable the bank-cash switch
   when the balance was already updated manually.

## Customizing

- **Shipping rates:** `DEFAULT_SHIPPING_FEE` / `SHIPPING_OVERRIDES` in `lib/districts.ts`.
- **Message templates:** `lib/templates.ts`.
- **Level thresholds:** `LEVELS` in `lib/metrics.ts`.
- **Parsing behavior:** `SYSTEM_PROMPT` in `lib/parse.ts`.
