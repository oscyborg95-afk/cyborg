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
| `/radar` | **Product Radar** — on-demand Sri Lankan product discovery, Meta competitor tracking, ranked public-signal shortlist and creative evidence |
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
3. Optional — Supabase: run `supabase/schema.sql` in the SQL editor, set `SUPABASE_URL`
   and `SUPABASE_SERVICE_ROLE_KEY`. Without these the app uses an in-memory store.
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

### Product Radar

Set `APIFY_TOKEN` to enable `/radar`; create one in
[Apify token settings](https://console.apify.com/settings/integrations). The
operator can then type any product or niche directly on the Radar page—for
example `face serum`, `kitchen gadgets`, or `car accessories`. Every search is
fixed to active Meta ads shown in Sri Lanka, identifies up to eight product
candidates, and replaces the prior shortlist with their local competitor
evidence.

The authenticated `/api/radar/cron` route runs daily at 05:30 Asia/Colombo and
repeats the most recent completed search. Before the first completed manual
search, it safely defaults to `cosmetics`. International TikTok enrichment is
optional and off by default because TikTok Creative Center does not expose Sri
Lanka as a country filter; when enabled, it supplements rather than replaces
Sri Lankan Meta evidence. Candidate caps, enrichment countries, timeouts, and
Actor IDs remain configurable through the `RADAR_*` /
`APIFY_*_ACTOR_ID` variables in `.env.local.example`.

Without a token and live scan, the page shows an explicitly labelled demo
shortlist. Radar scores public advertising evidence only; it does not claim
sales, spend, profitability, CPA, or ROAS.

### Tracking reliability

Set `COURIER_WEBHOOK_SECRET` for the TransExpress callback and `CRON_SECRET`
for the protected tracking fallback runner. `vercel.json` schedules a daily
00:00 Asia/Colombo recovery sweep, which is compatible with Vercel Hobby. On
Vercel Pro, change the schedule to `*/10 * * * *` for a ten-minute fallback.
For a ten-minute fallback on any Vercel plan, set Railway worker variables
`APP_TRACKING_CRON_URL=https://cyborg-fawn.vercel.app/api/tracking/cron` and
the same `CRON_SECRET` value used by Vercel.

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
| Automated product discovery + competitor evidence (Apify, daily cron, Postgres/in-memory) | `lib/product-radar.ts`, `app/api/radar/*`, `/radar` |
| Courier tracking auto-sync (booked → delivered/returned) | `lib/couriers.ts`, `app/api/track/sync/route.ts` |
| Orders + manifests data layer (Supabase or in-memory) | `lib/db.ts`, `supabase/schema.sql` |
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
