# Cyborg OS — Daily Cart Command Center

Unified omnichannel workspace for a solo operator running a WhatsApp COD funnel in
Sri Lanka. The entire business runs on one screen: live WhatsApp inbox, AI address
parsing, one-click courier dispatch, and a gamified high-score board.

## Routes

| Route | What it is |
|---|---|
| `/` | **Three-panel workspace** — searchable inbox (`/` to search, `j`/`k` to move) with triage filters and a follow-up queue for chats stuck mid-order, live chat with a state-aware quick-action bar, and the logistics copilot (parse from chat → COD risk check → dispatch → auto-message the customer) |
| `/orders` | Manual fallback flow (paste → parse → book → copy), order status bookkeeping, cash reconciliation (courier payouts → bank cash), returned-order redelivery flow, CSV export |
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
3. Optional — Supabase: run `supabase/schema.sql` in the SQL editor, set `SUPABASE_URL`
   and `SUPABASE_SERVICE_ROLE_KEY`. Without these the app uses an in-memory store.
4. Optional — courier: set `COURIER_API_URL` / `COURIER_API_KEY` and adjust the payload
   field names in `lib/couriers.ts` to your courier's docs. Mock tracking IDs otherwise.
5. `npm run dev` and open http://localhost:3000.

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
| Proactive tracking alerts (out-for-delivery / delivered / returned auto-messages) | `app/api/track/sync/route.ts` |
| Cash reconciliation (courier payout batches → bank cash) | `app/api/remittance/route.ts`, Orders page |
| Return workflow (redeliver offer + one-click re-book) | `app/api/orders/[id]/rebook/route.ts` |
| Ad spend + ROAS (manual daily entry, delivered-revenue attribution) | `app/api/adspend/route.ts`, Quest page |
| Broadcast (rate-limited, past customers only) | `app/broadcast/page.tsx` |
| Operator auth gate (`APP_PASSWORD`) | `proxy.ts`, `lib/auth.ts`, `app/login` |
| One-click dispatch (book + track + auto-message + state) | `app/api/dispatch/route.ts` |
| Chat state machine (drives the dynamic action bar) | `lib/db.ts`, `app/api/chat-state/route.ts` |
| Message templates (Sinhala) | `lib/templates.ts` |
| Gamified metrics (levels, streak, net worth) | `lib/metrics.ts`, `app/api/metrics/route.ts` |
| Products + physical stock (presets, auto restock on returns) | `app/api/products/*`, managed on `/analytics` |
| Courier tracking auto-sync (booked → delivered/returned) | `lib/couriers.ts`, `app/api/track/sync/route.ts` |
| Orders + manifests data layer (Supabase or in-memory) | `lib/db.ts`, `supabase/schema.sql` |
| Courier REST bridge (mock mode until keys are set) | `lib/couriers.ts` |

## The dispatch loop

1. Customer message lands in the inbox in real time (Socket.io push from the worker).
2. Open the chat → click **Parse address from chat** — the last customer messages go to
   the LLM and the form fills itself.
3. Set the product price → **DISPATCH**. One click: books the courier, stores the
   tracking ID, marks the chat SHIPPED, and auto-sends the Sinhala confirmation.
4. Tracking syncs itself: the workspace re-checks every parcel in flight every 10
   minutes (and `/orders` on every visit) — `delivered` feeds the level counter on
   `/analytics`, a courier return puts the unit back into product stock automatically,
   and the customer is auto-messaged on out-for-delivery / delivered / returned.
   A cron can also drive it: `POST /api/track/sync`.
5. When the courier hands over the COD payout, hit **Payout received** on `/orders` —
   the delivered total moves into bank cash on the Quest board.

## Customizing

- **Shipping rates:** `DEFAULT_SHIPPING_FEE` / `SHIPPING_OVERRIDES` in `lib/districts.ts`.
- **Message templates:** `lib/templates.ts`.
- **Level thresholds:** `LEVELS` in `lib/metrics.ts`.
- **Parsing behavior:** `SYSTEM_PROMPT` in `lib/parse.ts`.
