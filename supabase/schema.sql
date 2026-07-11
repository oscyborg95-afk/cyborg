-- Cyborg-V1 core tables. Run this in the Supabase SQL editor.

create extension if not exists "pgcrypto";

-- Short, human-friendly order numbers (DC-1001, DC-1002, …). The prefix lives in
-- business_settings.order_prefix; this sequence supplies the running number.
create sequence if not exists order_number_seq start 1001;

create table if not exists orders (
  id             uuid primary key default gen_random_uuid(),
  order_no       varchar, -- short reference sent to the courier, e.g. "DC-1001"
  customer_name  varchar not null,
  phone_number   varchar not null,
  phone_2        varchar not null default '',
  raw_address    text not null,
  parsed_address text not null,
  city           varchar not null default '',
  city_id        int,
  district       varchar not null,
  item_name      varchar not null default '',
  items          jsonb, -- [{product_id,name,qty,price}] for multi-product orders
  product_price  numeric not null default 0,
  shipping_fee   numeric not null default 0,
  discount       numeric not null default 0,
  total_cod      numeric not null default 0,
  order_status   varchar not null default 'pending', -- pending → booked → delivered → returned
  idempotency_key varchar,
  archived_at    timestamptz,
  created_at     timestamptz not null default now()
);

-- Product presets with physical stock. Stock moves with order status:
-- booked/delivered = out of the shed, pending/returned = in the shed.
create table if not exists products (
  id          uuid primary key default gen_random_uuid(),
  name        varchar not null,
  price       numeric not null default 0,
  unit_cost   numeric not null default 0,
  stock_units int not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists shipping_manifests (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  courier_name    varchar not null,
  tracking_id     varchar not null,
  pdf_label_url   text,
  last_checkpoint varchar,
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_shipping_manifests_order on shipping_manifests(order_id);

-- Per-order courier tracking timeline: one row per status change observed.
create table if not exists tracking_events (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders(id) on delete cascade,
  checkpoint varchar not null,
  outcome    varchar not null default 'in_transit', -- booked | in_transit | delivered | returned
  created_at timestamptz not null default now()
);
create index if not exists idx_tracking_events_order on tracking_events(order_id, created_at);

-- Record of the automated tracking-driven customer WhatsApp alerts actually
-- sent (out for delivery / delivered / returned), so the same alert is never
-- sent twice and failed sends stay visible for a manual retry.
create table if not exists customer_alerts (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders(id) on delete cascade,
  kind       varchar not null, -- out_for_delivery | delivered | returned
  body       text not null,    -- the exact message text sent
  status     varchar not null default 'sent', -- sent | failed
  created_at timestamptz not null default now()
);
-- At most one SUCCESSFUL send per (order, kind) — makes double-sending the same
-- alert structurally impossible; failed attempts are unconstrained (a log).
create unique index if not exists uq_customer_alerts_sent
  on customer_alerts(order_id, kind) where status = 'sent';
create index if not exists idx_customer_alerts_order on customer_alerts(order_id, created_at);

-- Cyborg OS: per-customer chat state machine (drives the dynamic action bar).
create table if not exists chat_states (
  phone_number varchar primary key,
  chat_id      varchar not null,
  display_name varchar,
  state        varchar not null default 'NEW', -- NEW → AWAITING_ADDRESS → AWAITING_CONFIRMATION → CONFIRMED → SHIPPED
  updated_at   timestamptz not null default now()
);

-- Cyborg OS: single-row settings for the gamified net-worth counter.
create table if not exists business_settings (
  id               int primary key default 1,
  bank_cash        numeric not null default 0,
  stock_units      int not null default 0,
  stock_unit_cost  numeric not null default 155.83,
  business_name    varchar not null default '',
  business_address varchar not null default '',
  business_phone_1 varchar not null default '',
  business_phone_2 varchar not null default '',
  order_prefix     varchar not null default 'DC', -- prefix for short order numbers
  templates        jsonb not null default '{}'::jsonb, -- WhatsApp template overrides
  -- What the COURIER charges you (drives the real profit numbers, separate from
  -- the shipping_fee the customer pays). Base delivered fee + per-district
  -- overrides (mirrors DEFAULT_SHIPPING_FEE / SHIPPING_OVERRIDES), plus the flat
  -- fee eaten on a returned parcel (the round-trip loss).
  courier_cost_base      numeric not null default 350,
  courier_return_cost    numeric not null default 200,
  courier_cost_overrides jsonb   not null default '{}'::jsonb, -- { "Jaffna": 450, ... } delivered-cost overrides
  -- Operator's own Gemini API key(s) for AI address parsing. One key per line;
  -- the parser rotates to the next key when one hits its free-tier rate limit.
  -- Overrides the GEMINI_API_KEY env var when set.
  gemini_api_key   varchar not null default ''
);
insert into business_settings (id) values (1) on conflict do nothing;

-- Daily Meta/Facebook ad spend, entered manually — feeds the ROAS card.
create table if not exists ad_spend (
  day    date primary key,
  amount numeric not null default 0
);

-- Actual courier settlement batches. Gross COD remains useful operationally,
-- but bank cash increases only by amount_received (the net deposit).
create table if not exists courier_remittances (
  id                uuid primary key default gen_random_uuid(),
  invoice_no        varchar not null unique,
  paid_at           timestamptz not null,
  source_filename   varchar not null,
  source_mime       varchar not null default 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  source_file       bytea not null,
  line_count        int not null,
  matched_count     int not null default 0,
  gross_cod         numeric not null,
  collected_cod     numeric not null,
  delivery_charges  numeric not null,
  commission        numeric not null,
  invoice_vat       numeric not null,
  additional_tax    numeric not null default 0,
  other_deductions  numeric not null default 0,
  invoice_payable   numeric not null,
  expected_net      numeric not null,
  amount_received   numeric not null,
  variance          numeric not null,
  cash_applied      boolean not null default true,
  notes             text not null default '',
  created_at        timestamptz not null default now()
);

create table if not exists courier_remittance_lines (
  id                 uuid primary key default gen_random_uuid(),
  remittance_id      uuid not null references courier_remittances(id) on delete cascade,
  matched_order_id   uuid references orders(id) on delete set null,
  order_date         varchar not null default '',
  waybill_id         varchar not null,
  order_no           varchar not null default '',
  cod                numeric not null,
  collected_cod      numeric not null,
  vat                numeric not null,
  commission         numeric not null,
  delivery_charge    numeric not null,
  payable            numeric not null,
  status             varchar not null default ''
);

-- For existing databases created before these columns were added:
alter table orders add column if not exists city varchar not null default '';
alter table orders add column if not exists item_name varchar not null default '';
alter table orders add column if not exists discount numeric not null default 0;
alter table orders add column if not exists product_id uuid references products(id) on delete set null;
alter table orders add column if not exists phone_2 varchar not null default '';
alter table orders add column if not exists city_id int;
alter table orders add column if not exists items jsonb;
alter table orders add column if not exists remitted_at timestamptz; -- COD payout received (cash reconciliation)
alter table orders add column if not exists order_no varchar; -- short courier reference (DC-1001)
alter table orders add column if not exists idempotency_key varchar;
alter table orders add column if not exists archived_at timestamptz;
alter table orders add column if not exists remittance_id uuid references courier_remittances(id) on delete set null;
create unique index if not exists uq_orders_idempotency_key
  on orders(idempotency_key) where idempotency_key is not null;
alter table business_settings add column if not exists order_prefix varchar not null default 'DC';
alter table business_settings add column if not exists templates jsonb not null default '{}'::jsonb;
alter table business_settings add column if not exists business_name varchar not null default '';
alter table business_settings add column if not exists business_address varchar not null default '';
alter table business_settings add column if not exists business_phone_1 varchar not null default '';
alter table business_settings add column if not exists business_phone_2 varchar not null default '';
alter table business_settings add column if not exists courier_cost_base numeric not null default 350;
alter table business_settings add column if not exists courier_return_cost numeric not null default 200;
alter table business_settings add column if not exists courier_cost_overrides jsonb not null default '{}'::jsonb;

create index if not exists idx_orders_status on orders(order_status);
create index if not exists idx_manifests_order on shipping_manifests(order_id);
create unique index if not exists uq_manifests_tracking on shipping_manifests(tracking_id);

-- Durable courier webhook inbox. fingerprint makes provider retries idempotent.
create table if not exists courier_webhook_events (
  id               uuid primary key default gen_random_uuid(),
  fingerprint      varchar not null unique,
  tracking_id      varchar not null,
  order_id         uuid not null references orders(id) on delete cascade,
  status           varchar not null,
  checkpoint       text not null,
  attempt          int,
  payload          jsonb not null default '{}'::jsonb,
  received_at      timestamptz not null default now(),
  processed_at     timestamptz,
  processing_error text not null default ''
);
create index if not exists idx_webhook_events_order
  on courier_webhook_events(order_id, received_at desc);
create index if not exists idx_webhook_events_received
  on courier_webhook_events(received_at desc);

-- Durable WhatsApp outbox. Failed jobs are retried with exponential backoff.
create table if not exists tracking_notification_jobs (
  id               uuid primary key default gen_random_uuid(),
  webhook_event_id uuid references courier_webhook_events(id) on delete cascade,
  order_id         uuid not null references orders(id) on delete cascade,
  recipient        varchar not null,
  alert_kind       varchar,
  chat_id          varchar not null,
  body             text not null,
  status           varchar not null default 'pending',
  attempts         int not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text not null default '',
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create unique index if not exists uq_tracking_notification_event_recipient
  on tracking_notification_jobs(webhook_event_id, recipient)
  where webhook_event_id is not null;
create index if not exists idx_tracking_notification_due
  on tracking_notification_jobs(status, next_attempt_at);
