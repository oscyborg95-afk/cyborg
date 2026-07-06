-- Cyborg-V1 core tables. Run this in the Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists orders (
  id             uuid primary key default gen_random_uuid(),
  customer_name  varchar not null,
  phone_number   varchar not null,
  phone_2        varchar not null default '',
  raw_address    text not null,
  parsed_address text not null,
  city           varchar not null default '',
  district       varchar not null,
  item_name      varchar not null default '',
  product_price  numeric not null default 0,
  shipping_fee   numeric not null default 0,
  discount       numeric not null default 0,
  total_cod      numeric not null default 0,
  order_status   varchar not null default 'pending', -- pending → booked → delivered → returned
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

-- Per-order courier tracking timeline: one row per status change observed.
create table if not exists tracking_events (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders(id) on delete cascade,
  checkpoint varchar not null,
  outcome    varchar not null default 'in_transit', -- booked | in_transit | delivered | returned
  created_at timestamptz not null default now()
);
create index if not exists idx_tracking_events_order on tracking_events(order_id, created_at);

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
  business_phone_2 varchar not null default ''
);
insert into business_settings (id) values (1) on conflict do nothing;

-- For existing databases created before these columns were added:
alter table orders add column if not exists city varchar not null default '';
alter table orders add column if not exists item_name varchar not null default '';
alter table orders add column if not exists discount numeric not null default 0;
alter table orders add column if not exists product_id uuid references products(id) on delete set null;
alter table orders add column if not exists phone_2 varchar not null default '';
alter table business_settings add column if not exists business_name varchar not null default '';
alter table business_settings add column if not exists business_address varchar not null default '';
alter table business_settings add column if not exists business_phone_1 varchar not null default '';
alter table business_settings add column if not exists business_phone_2 varchar not null default '';

create index if not exists idx_orders_status on orders(order_status);
create index if not exists idx_manifests_order on shipping_manifests(order_id);
