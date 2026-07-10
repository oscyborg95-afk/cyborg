import { Pool, types } from "pg";
import type { PoolClient } from "pg";
import { randomUUID } from "crypto";
import type {
  AdSpend,
  AlertKind,
  BusinessSettings,
  ChatState,
  ChatStateValue,
  CustomerAlert,
  NewOrder,
  NewProduct,
  Order,
  OrderStatus,
  Product,
  ShippingManifest,
  TrackingEvent,
} from "./types";

// Data layer. Connects directly to Postgres (Supabase) when DATABASE_URL is set,
// otherwise falls back to an in-memory store so the dashboard works before the
// database is provisioned. In-memory data is lost on server restart.
//
// Type parsers keep the shapes identical to what the app expects:
//   numeric (money)  -> JS number, so price math never becomes string concat
//   timestamptz      -> ISO string, matching the previous Supabase-JS behaviour
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
const toIso = (v: string | null) => (v === null ? null : new Date(v).toISOString());
types.setTypeParser(1184, toIso); // timestamptz
types.setTypeParser(1114, toIso); // timestamp
types.setTypeParser(1082, (v) => v); // date -> keep as "YYYY-MM-DD" string

const DATABASE_URL = process.env.DATABASE_URL;
export const usingSupabase = Boolean(DATABASE_URL);

// Survive Next.js dev-server hot reloads (one pool, one set of fallback maps).
const g = globalThis as unknown as {
  __cyborgPool?: Pool;
  __cyborgOrders?: Map<string, Order>;
  __cyborgManifests?: Map<string, ShippingManifest>;
  __cyborgChatStates?: Map<string, ChatState>;
  __cyborgSettings?: BusinessSettings;
  __cyborgProducts?: Map<string, Product>;
  __cyborgTrackingEvents?: TrackingEvent[];
  __cyborgAdSpend?: Map<string, number>;
  __cyborgOrderSeq?: number; // in-memory running number for short order refs
  __orderNoReady?: boolean; // whether the order_no schema has been ensured
  __orderSafetyReady?: boolean; // idempotency/archive/manifest uniqueness schema
  __cyborgAlerts?: Map<string, CustomerAlert>; // in-memory customer-alert log
  __alertsReady?: boolean; // whether the customer_alerts table has been ensured
  __cyborgOrderLocks?: Map<string, Promise<void>>;
  __cyborgTrackingSyncRunning?: boolean;
};

let pool: Pool | null = null;
if (DATABASE_URL) {
  pool = g.__cyborgPool ??= new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
}

// Either the pool or a single checked-out client mid-transaction. Data functions
// take an optional executor so a caller can thread several writes through one
// BEGIN/COMMIT; default to the pool for standalone, auto-committed queries.
type Queryable = Pick<Pool, "query">;

// Run `fn` inside a single Postgres transaction. In memory-fallback mode (no
// pool) there is nothing to transact, so it just runs the body with a null
// executor and the data functions hit their in-memory maps as usual.
export async function withTransaction<T>(
  fn: (db: Queryable | null) => Promise<T>
): Promise<T> {
  if (!pool) return fn(null);
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const memOrders = (g.__cyborgOrders ??= new Map<string, Order>());
const memManifests = (g.__cyborgManifests ??= new Map<string, ShippingManifest>());
const memChatStates = (g.__cyborgChatStates ??= new Map<string, ChatState>());
const memProducts = (g.__cyborgProducts ??= new Map<string, Product>());
const memTrackingEvents = (g.__cyborgTrackingEvents ??= []);
const memAdSpend = (g.__cyborgAdSpend ??= new Map<string, number>()); // day -> Rs.
const memAlerts = (g.__cyborgAlerts ??= new Map<string, CustomerAlert>());
const memOrderLocks = (g.__cyborgOrderLocks ??= new Map<string, Promise<void>>());

const DEFAULT_SETTINGS: BusinessSettings = {
  bank_cash: 0,
  stock_units: 0,
  stock_unit_cost: 155.83,
  business_name: "Daily Cart",
  business_address: "",
  business_phone_1: "",
  business_phone_2: "",
  order_prefix: "DC",
  templates: {},
  courier_cost_base: 350,
  courier_return_cost: 200,
  courier_cost_overrides: {},
  gemini_api_key: "",
};

// --- Orders ------------------------------------------------------------------

// Idempotently make sure the short-order-number schema exists (sequence + the
// order_no / order_prefix columns). Runs once per process — matches the app's
// existing self-migration pattern so a fresh DB works without a manual schema run.
async function ensureOrderSafetySchema(db: Queryable): Promise<void> {
  if (g.__orderSafetyReady) return;
  await db.query("alter table orders add column if not exists idempotency_key varchar");
  await db.query("alter table orders add column if not exists archived_at timestamptz");
  await db.query(
    "create unique index if not exists uq_orders_idempotency_key on orders(idempotency_key) where idempotency_key is not null"
  );
  await db.query(
    "create unique index if not exists uq_shipping_manifests_order on shipping_manifests(order_id)"
  );
  g.__orderSafetyReady = true;
}

async function ensureOrderNoSchema(db: Queryable): Promise<void> {
  await ensureOrderSafetySchema(db);
  if (g.__orderNoReady) return;
  await db.query("create sequence if not exists order_number_seq start 1001");
  await db.query("alter table orders add column if not exists order_no varchar");
  await db.query(
    "alter table business_settings add column if not exists order_prefix varchar not null default 'DC'"
  );
  // Courier-cost columns power the real-profit numbers; add them here so a DB
  // created before the profit brain existed self-heals on first settings read.
  await db.query(
    "alter table business_settings add column if not exists courier_cost_base numeric not null default 350"
  );
  await db.query(
    "alter table business_settings add column if not exists courier_return_cost numeric not null default 200"
  );
  await db.query(
    "alter table business_settings add column if not exists courier_cost_overrides jsonb not null default '{}'::jsonb"
  );
  // getSettings also reads these; older DBs created before they existed would
  // fail the SELECT, so self-heal them here too (idempotent).
  await db.query(
    "alter table business_settings add column if not exists templates jsonb not null default '{}'::jsonb"
  );
  await db.query(
    "alter table business_settings add column if not exists business_name varchar not null default ''"
  );
  await db.query(
    "alter table business_settings add column if not exists business_address varchar not null default ''"
  );
  await db.query(
    "alter table business_settings add column if not exists business_phone_1 varchar not null default ''"
  );
  await db.query(
    "alter table business_settings add column if not exists business_phone_2 varchar not null default ''"
  );
  await db.query(
    "alter table business_settings add column if not exists gemini_api_key varchar not null default ''"
  );
  g.__orderNoReady = true;
}

// Next short reference: "<prefix>-<running number>", e.g. "DC-1001". The prefix
// comes from business_settings; the number from the atomic Postgres sequence.
async function nextOrderNo(db: Queryable): Promise<string> {
  const settings = await db.query("select order_prefix from business_settings where id = 1");
  const prefix = (settings.rows[0]?.order_prefix as string) || "DC";
  const { rows } = await db.query("select nextval('order_number_seq') as n");
  return `${prefix}-${rows[0].n}`;
}

export async function createOrder(
  input: NewOrder,
  db: Queryable | null = pool,
  idempotencyKey: string | null = null
): Promise<Order> {
  if (db) {
    await ensureOrderNoSchema(db);
    const order_no = await nextOrderNo(db);
    const { rows } = await db.query(
      `insert into orders
         (order_no, customer_name, phone_number, phone_2, raw_address, parsed_address, city, city_id, district,
          product_id, item_name, items, product_price, shipping_fee, discount, total_cod,
          idempotency_key, order_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'pending')
       on conflict (idempotency_key) where idempotency_key is not null do nothing
       returning *`,
      [
        order_no,
        input.customer_name,
        input.phone_number,
        input.phone_2,
        input.raw_address,
        input.parsed_address,
        input.city,
        input.city_id,
        input.district,
        input.product_id,
        input.item_name,
        // pg serializes arrays as Postgres arrays — jsonb needs explicit JSON.
        input.items && input.items.length > 0 ? JSON.stringify(input.items) : null,
        input.product_price,
        input.shipping_fee,
        input.discount,
        input.total_cod,
        idempotencyKey,
      ]
    );
    if (rows[0]) return rows[0] as Order;
    const existing = await db.query("select * from orders where idempotency_key = $1", [idempotencyKey]);
    if (!existing.rows[0]) throw new Error("Idempotent order creation failed");
    return existing.rows[0] as Order;
  }
  if (idempotencyKey) {
    const existing = [...memOrders.values()].find((o) => o.idempotency_key === idempotencyKey);
    if (existing) return existing;
  }
  const seq = (g.__cyborgOrderSeq = (g.__cyborgOrderSeq ?? 1000) + 1);
  const prefix = (g.__cyborgSettings ?? DEFAULT_SETTINGS).order_prefix || "DC";
  const order: Order = {
    ...input,
    id: randomUUID(),
    order_no: `${prefix}-${seq}`,
    order_status: "pending",
    remitted_at: null,
    idempotency_key: idempotencyKey,
    archived_at: null,
    created_at: new Date().toISOString(),
  };
  memOrders.set(order.id, order);
  return order;
}

async function withMemOrderLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = memOrderLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => gate);
  memOrderLocks.set(id, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (memOrderLocks.get(id) === tail) memOrderLocks.delete(id);
  }
}

// Archive instead of deleting business history. Booked parcels must first be
// returned/cancelled with the courier so they cannot disappear while in flight.
export async function archiveOrder(id: string): Promise<void> {
  const run = async (db: Queryable | null) => {
    const order = db
      ? ((await db.query("select * from orders where id = $1 for update", [id])).rows[0] as Order | undefined)
      : memOrders.get(id);
    if (!order) return;
    if (order.order_status === "booked") {
      throw new Error("Booked orders cannot be archived until they are delivered or returned");
    }
    if (order.order_status === "delivered" && !order.remitted_at) {
      throw new Error("Delivered orders cannot be archived until their COD payout is recorded");
    }
    const archivedAt = new Date().toISOString();
    if (db) await db.query("update orders set archived_at = $1 where id = $2", [archivedAt, id]);
    else memOrders.set(id, { ...order, archived_at: archivedAt });
  };
  if (pool) await withTransaction(run);
  else await withMemOrderLock(id, () => run(null));
}

export async function listOrders(includeArchived = false): Promise<Order[]> {
  if (pool) {
    await ensureOrderNoSchema(pool);
    const { rows } = await pool.query(
      `select * from orders
       where ($1::boolean or archived_at is null)
       order by created_at desc limit 200`,
      [includeArchived]
    );
    return rows as Order[];
  }
  return [...memOrders.values()]
    .filter((o) => includeArchived || !o.archived_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getOrder(
  id: string,
  db: Queryable | null = pool
): Promise<Order | null> {
  if (db) {
    const { rows } = await db.query("select * from orders where id = $1", [id]);
    return (rows[0] as Order) ?? null;
  }
  return memOrders.get(id) ?? null;
}

// How many units of stock a status implies are OUT of the shed.
// pending: still on the shelf. booked: riding with the courier. delivered: sold.
// returned: physically back on the shelf.
const STOCK_OUT: Record<OrderStatus, number> = {
  pending: 0,
  booked: 1,
  delivered: 1,
  returned: 0,
};

export async function updateOrderStatus(
  id: string,
  status: OrderStatus,
  db?: Queryable | null
): Promise<void> {
  // Standalone transitions create their own transaction/mutex. Callers already
  // holding an order transaction pass its executor explicitly.
  if (db === undefined) {
    if (pool) return withTransaction((tx) => updateOrderStatus(id, status, tx));
    return withMemOrderLock(id, () => updateOrderStatus(id, status, null));
  }
  const order = db
    ? (((await db.query("select * from orders where id = $1 for update", [id])).rows[0] as Order) ?? null)
    : await getOrder(id, null);
  if (!order) throw new Error("Order not found");
  const oldStatus = order.order_status;

  if (db) {
    await db.query("update orders set order_status = $1 where id = $2", [status, id]);
  } else {
    memOrders.set(id, { ...order, order_status: status });
  }

  // Keep the products' physical stock in sync with where the parcel is.
  // Multi-product orders move each line item by its quantity; legacy orders
  // fall back to the single product_id (one unit).
  if (oldStatus !== status) {
    const delta = STOCK_OUT[oldStatus] - STOCK_OUT[status];
    if (delta !== 0) {
      if (order.items && order.items.length > 0) {
        for (const item of order.items) {
          if (item.product_id && item.qty > 0) {
            await adjustProductStock(item.product_id, delta * item.qty, db);
          }
        }
      } else if (order.product_id) {
        await adjustProductStock(order.product_id, delta, db);
      }
    }
  }
}

export class OrderBookingConflictError extends Error {}

// Serialize the external courier call and the local manifest/status writes for
// one order. The unique manifest index is a second line of defence.
export async function bookOrderOnce(
  id: string,
  book: (order: Order) => Promise<BookingResultLike>
): Promise<{ order: Order; manifest: ShippingManifest; reused: boolean }> {
  const run = async (db: Queryable | null) => {
    const order = db
      ? (((await db.query("select * from orders where id = $1 for update", [id])).rows[0] as Order) ?? null)
      : await getOrder(id, null);
    if (!order) throw new Error("Order not found");
    const existing = db
      ? ((await db.query("select * from shipping_manifests where order_id = $1 limit 1", [id])).rows[0] as ShippingManifest | undefined)
      : [...memManifests.values()].find((m) => m.order_id === id);
    if (existing) return { order, manifest: existing, reused: true };
    if (order.order_status !== "pending") {
      throw new OrderBookingConflictError(`Order is already ${order.order_status}`);
    }
    const booking = await book(order);
    const manifest = await createManifest(
      {
        order_id: id,
        courier_name: booking.courier_name,
        tracking_id: booking.tracking_id,
        pdf_label_url: booking.pdf_label_url,
        last_checkpoint: "booked",
      },
      db
    );
    await updateOrderStatus(id, "booked", db);
    await addTrackingEvent(id, `Booked with ${booking.courier_name}`, "booked", db);
    return { order: { ...order, order_status: "booked" as const }, manifest, reused: false };
  };
  if (pool) return withTransaction(run);
  return withMemOrderLock(id, () => run(null));
}

interface BookingResultLike {
  courier_name: string;
  tracking_id: string;
  pdf_label_url: string | null;
}

// Only one tracking sweep may run across all app instances. A skipped caller
// returns null immediately instead of duplicating status and message side effects.
export async function withExclusiveTrackingSync<T>(fn: () => Promise<T>): Promise<T | null> {
  if (!pool) {
    if (g.__cyborgTrackingSyncRunning) return null;
    g.__cyborgTrackingSyncRunning = true;
    try {
      return await fn();
    } finally {
      g.__cyborgTrackingSyncRunning = false;
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "select pg_try_advisory_xact_lock(hashtext('cyborg_tracking_sync')) as acquired"
    );
    if (!rows[0]?.acquired) {
      await client.query("ROLLBACK");
      return null;
    }
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// --- Shipping manifests ------------------------------------------------------

export async function createManifest(
  input: Omit<ShippingManifest, "id" | "created_at">,
  db: Queryable | null = pool
): Promise<ShippingManifest> {
  if (db) {
    const { rows } = await db.query(
      `insert into shipping_manifests
         (order_id, courier_name, tracking_id, pdf_label_url, last_checkpoint)
       values ($1,$2,$3,$4,$5)
       returning *`,
      [input.order_id, input.courier_name, input.tracking_id, input.pdf_label_url, input.last_checkpoint]
    );
    return rows[0] as ShippingManifest;
  }
  const manifest: ShippingManifest = {
    ...input,
    id: randomUUID(),
    created_at: new Date().toISOString(),
  };
  memManifests.set(manifest.id, manifest);
  return manifest;
}

export async function listManifests(): Promise<ShippingManifest[]> {
  if (pool) {
    const { rows } = await pool.query("select * from shipping_manifests limit 500");
    return rows as ShippingManifest[];
  }
  return [...memManifests.values()];
}

export async function updateManifestCheckpoint(id: string, checkpoint: string): Promise<void> {
  if (pool) {
    await pool.query("update shipping_manifests set last_checkpoint = $1 where id = $2", [
      checkpoint,
      id,
    ]);
    return;
  }
  const manifest = memManifests.get(id);
  if (manifest) memManifests.set(id, { ...manifest, last_checkpoint: checkpoint });
}

// --- Products (presets + physical stock) -------------------------------------

export async function listProducts(): Promise<Product[]> {
  if (pool) {
    const { rows } = await pool.query("select * from products order by created_at asc");
    return rows as Product[];
  }
  return [...memProducts.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function createProduct(input: NewProduct): Promise<Product> {
  if (pool) {
    const { rows } = await pool.query(
      `insert into products (name, price, unit_cost, stock_units)
       values ($1,$2,$3,$4) returning *`,
      [input.name, input.price, input.unit_cost, input.stock_units]
    );
    return rows[0] as Product;
  }
  const product: Product = {
    ...input,
    id: randomUUID(),
    created_at: new Date().toISOString(),
  };
  memProducts.set(product.id, product);
  return product;
}

const PRODUCT_FIELDS: (keyof NewProduct)[] = ["name", "price", "unit_cost", "stock_units"];

export async function updateProduct(
  id: string,
  patch: Partial<NewProduct>
): Promise<Product | null> {
  if (pool) {
    const cols = PRODUCT_FIELDS.filter((f) => patch[f] !== undefined);
    if (cols.length === 0) {
      const { rows } = await pool.query("select * from products where id = $1", [id]);
      return (rows[0] as Product) ?? null;
    }
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
    const values = cols.map((c) => patch[c]);
    values.push(id);
    const { rows } = await pool.query(
      `update products set ${setClause} where id = $${values.length} returning *`,
      values
    );
    return (rows[0] as Product) ?? null;
  }
  const product = memProducts.get(id);
  if (!product) return null;
  const next = { ...product, ...patch };
  memProducts.set(id, next);
  return next;
}

export async function deleteProduct(id: string): Promise<void> {
  if (pool) {
    await pool.query("delete from products where id = $1", [id]);
    return;
  }
  memProducts.delete(id);
}

export async function adjustProductStock(
  id: string,
  delta: number,
  db: Queryable | null = pool
): Promise<void> {
  if (db) {
    // Atomic: clamp at zero without a read-then-write race.
    await db.query(
      "update products set stock_units = greatest(0, stock_units + $1) where id = $2",
      [delta, id]
    );
    return;
  }
  const product = memProducts.get(id);
  if (product) {
    memProducts.set(id, { ...product, stock_units: Math.max(0, product.stock_units + delta) });
  }
}

// Buying new stock: add `quantity` units bought at `unitCost` each, and roll the
// product's unit_cost to the new weighted average. This keeps the net-worth
// stock valuation honest when the cost price changes between purchases.
//   new_cost = (old_stock*old_cost + qty*buy_cost) / (old_stock + qty)
export async function receiveProductStock(
  id: string,
  quantity: number,
  unitCost: number
): Promise<Product | null> {
  if (pool) {
    // Both SET expressions read the pre-update column values, so this is a
    // correct single-statement weighted average with no read-then-write race.
    const { rows } = await pool.query(
      `update products set
         unit_cost = case when (stock_units + $2) > 0
           then (stock_units * unit_cost + $2 * $3) / (stock_units + $2)
           else $3 end,
         stock_units = stock_units + $2
       where id = $1
       returning *`,
      [id, quantity, unitCost]
    );
    return (rows[0] as Product) ?? null;
  }
  const product = memProducts.get(id);
  if (!product) return null;
  const newStock = product.stock_units + quantity;
  const newCost =
    newStock > 0
      ? (product.stock_units * product.unit_cost + quantity * unitCost) / newStock
      : unitCost;
  const next = { ...product, stock_units: newStock, unit_cost: newCost };
  memProducts.set(id, next);
  return next;
}

// --- Tracking events (per-order courier timeline) ---------------------------

// Postgres "undefined_table" — the tracking_events migration hasn't been run
// yet. The timeline is additive, so degrade gracefully rather than 500 / break
// a booking until the operator applies the migration.
function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: string }).code === "42P01"
  );
}

export async function addTrackingEvent(
  order_id: string,
  checkpoint: string,
  outcome: string,
  db: Queryable | null = pool
): Promise<void> {
  if (db) {
    try {
      await db.query(
        "insert into tracking_events (order_id, checkpoint, outcome) values ($1,$2,$3)",
        [order_id, checkpoint, outcome]
      );
    } catch (err) {
      if (!isUndefinedTable(err)) throw err; // never fail a booking over a timeline row
    }
    return;
  }
  memTrackingEvents.push({
    id: randomUUID(),
    order_id,
    checkpoint,
    outcome,
    created_at: new Date().toISOString(),
  });
}

export async function listTrackingEvents(): Promise<TrackingEvent[]> {
  if (pool) {
    try {
      const { rows } = await pool.query(
        "select * from tracking_events order by created_at asc limit 2000"
      );
      return rows as TrackingEvent[];
    } catch (err) {
      if (isUndefinedTable(err)) return [];
      throw err;
    }
  }
  return [...memTrackingEvents].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function getLatestTrackingEvent(order_id: string): Promise<TrackingEvent | null> {
  if (pool) {
    try {
      const { rows } = await pool.query(
        "select * from tracking_events where order_id = $1 order by created_at desc limit 1",
        [order_id]
      );
      return (rows[0] as TrackingEvent) ?? null;
    } catch (err) {
      if (isUndefinedTable(err)) return null;
      throw err;
    }
  }
  const evs = memTrackingEvents
    .filter((e) => e.order_id === order_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return evs[0] ?? null;
}

// --- Customer alerts (tracking-driven WhatsApp messages) ---------------------

// Idempotently make sure the customer_alerts table + indexes exist. Runs once
// per process (like ensureOrderNoSchema) so this feature self-heals on a DB
// that predates it, instead of silently swallowing "table does not exist".
async function ensureAlertsSchema(db: Queryable): Promise<void> {
  if (g.__alertsReady) return;
  await db.query(
    `create table if not exists customer_alerts (
       id         uuid primary key default gen_random_uuid(),
       order_id   uuid not null references orders(id) on delete cascade,
       kind       varchar not null,
       body       text not null,
       status     varchar not null default 'sent',
       created_at timestamptz not null default now()
     )`
  );
  await db.query(
    `create unique index if not exists uq_customer_alerts_sent
       on customer_alerts(order_id, kind) where status = 'sent'`
  );
  await db.query(
    "create index if not exists idx_customer_alerts_order on customer_alerts(order_id, created_at)"
  );
  g.__alertsReady = true;
}

export async function listCustomerAlerts(): Promise<CustomerAlert[]> {
  if (pool) {
    await ensureAlertsSchema(pool);
    const { rows } = await pool.query(
      "select * from customer_alerts order by created_at desc limit 2000"
    );
    return rows as CustomerAlert[];
  }
  return [...memAlerts.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Has this exact alert already been delivered for this order? The gate that
// stops the auto-sweep (and a careless manual click) from sending it twice.
export async function hasSentAlert(order_id: string, kind: AlertKind): Promise<boolean> {
  if (pool) {
    await ensureAlertsSchema(pool);
    const { rows } = await pool.query(
      "select 1 from customer_alerts where order_id = $1 and kind = $2 and status = 'sent' limit 1",
      [order_id, kind]
    );
    return rows.length > 0;
  }
  return [...memAlerts.values()].some(
    (a) => a.order_id === order_id && a.kind === kind && a.status === "sent"
  );
}

// Record the outcome of an alert send. A 'sent' row upserts onto the single
// allowed successful row per (order, kind) — so an intentional resend just
// refreshes its timestamp/body rather than piling up duplicates. 'failed' rows
// accumulate as an attempt log.
export async function recordCustomerAlert(
  order_id: string,
  kind: AlertKind,
  body: string,
  status: "sent" | "failed"
): Promise<CustomerAlert> {
  if (pool) {
    await ensureAlertsSchema(pool);
    if (status === "sent") {
      const { rows } = await pool.query(
        `insert into customer_alerts (order_id, kind, body, status, created_at)
         values ($1,$2,$3,'sent', now())
         on conflict (order_id, kind) where status = 'sent'
         do update set body = excluded.body, created_at = now()
         returning *`,
        [order_id, kind, body]
      );
      return rows[0] as CustomerAlert;
    }
    const { rows } = await pool.query(
      `insert into customer_alerts (order_id, kind, body, status)
       values ($1,$2,$3,'failed') returning *`,
      [order_id, kind, body]
    );
    return rows[0] as CustomerAlert;
  }
  const record: CustomerAlert = {
    id: randomUUID(),
    order_id,
    kind,
    body,
    status,
    created_at: new Date().toISOString(),
  };
  // Mirror the DB's single-sent-row rule; keep each failure as its own log line.
  const key = status === "sent" ? `sent:${order_id}:${kind}` : record.id;
  memAlerts.set(key, record);
  return record;
}

// --- Cash reconciliation (courier COD remittances) ---------------------------

// Postgres "undefined_column" — the remitted_at migration hasn't been run yet.
function isUndefinedColumn(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as { code?: string }).code === "42703"
  );
}

/**
 * Mark a batch of delivered orders as paid out by the courier: stamps
 * remitted_at and moves the batch total into business_settings.bank_cash,
 * atomically. Only delivered + not-yet-remitted orders in `ids` count.
 */
export async function remitOrders(ids: string[]): Promise<{ count: number; total: number }> {
  const run = () =>
    withTransaction(async (db) => {
      if (db) {
        const { rows } = await db.query(
          `update orders set remitted_at = now()
           where id = any($1) and order_status = 'delivered' and remitted_at is null
           returning total_cod`,
          [ids]
        );
        const total = rows.reduce((sum, r) => sum + Number(r.total_cod), 0);
        if (rows.length > 0) {
          await db.query(
            "update business_settings set bank_cash = bank_cash + $1 where id = 1",
            [total]
          );
        }
        return { count: rows.length, total };
      }
      let total = 0;
      let count = 0;
      for (const id of ids) {
        const order = memOrders.get(id);
        if (order && order.order_status === "delivered" && !order.remitted_at) {
          memOrders.set(id, { ...order, remitted_at: new Date().toISOString() });
          total += Number(order.total_cod);
          count++;
        }
      }
      if (count > 0) {
        const s = g.__cyborgSettings ?? DEFAULT_SETTINGS;
        g.__cyborgSettings = { ...s, bank_cash: s.bank_cash + total };
      }
      return { count, total };
    });

  try {
    return await run();
  } catch (err) {
    // Self-migrate: the column is additive and nullable, so adding it in place
    // is safe — spares the operator a manual schema.sql run.
    if (pool && isUndefinedColumn(err)) {
      await pool.query("alter table orders add column if not exists remitted_at timestamptz");
      return run();
    }
    throw err;
  }
}

// --- Ad spend (manual daily entry, feeds ROAS) --------------------------------

export async function listAdSpend(): Promise<AdSpend[]> {
  if (pool) {
    try {
      const { rows } = await pool.query(
        "select day, amount from ad_spend order by day desc limit 60"
      );
      return rows as AdSpend[];
    } catch (err) {
      if (isUndefinedTable(err)) return []; // migration not run yet — additive feature
      throw err;
    }
  }
  return [...memAdSpend.entries()]
    .map(([day, amount]) => ({ day, amount }))
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, 60);
}

export async function upsertAdSpend(day: string, amount: number): Promise<void> {
  if (pool) {
    const write = () =>
      pool!.query(
        `insert into ad_spend (day, amount) values ($1, $2)
         on conflict (day) do update set amount = excluded.amount`,
        [day, amount]
      );
    try {
      await write();
    } catch (err) {
      if (!isUndefinedTable(err)) throw err;
      // Self-migrate on first use.
      await pool.query(
        "create table if not exists ad_spend (day date primary key, amount numeric not null default 0)"
      );
      await write();
    }
    return;
  }
  memAdSpend.set(day, amount);
}

// --- Chat states (Cyborg OS) -----------------------------------------------

export async function listChatStates(): Promise<ChatState[]> {
  if (pool) {
    const { rows } = await pool.query("select * from chat_states limit 1000");
    return rows as ChatState[];
  }
  return [...memChatStates.values()];
}

export async function upsertChatState(
  phone_number: string,
  chat_id: string,
  state: ChatStateValue,
  display_name?: string | null
): Promise<ChatState> {
  if (pool) {
    // coalesce keeps an existing display name when this call doesn't carry one.
    const { rows } = await pool.query(
      `insert into chat_states (phone_number, chat_id, display_name, state, updated_at)
       values ($1,$2,$3,$4, now())
       on conflict (phone_number) do update set
         chat_id = excluded.chat_id,
         display_name = coalesce(excluded.display_name, chat_states.display_name),
         state = excluded.state,
         updated_at = now()
       returning *`,
      [phone_number, chat_id, display_name ?? null, state]
    );
    return rows[0] as ChatState;
  }
  const record: ChatState = {
    phone_number,
    chat_id,
    display_name: display_name ?? memChatStates.get(phone_number)?.display_name ?? null,
    state,
    updated_at: new Date().toISOString(),
  };
  memChatStates.set(phone_number, record);
  return record;
}

// --- Business settings (gamified net-worth counter) -------------------------

export async function getSettings(): Promise<BusinessSettings> {
  if (pool) {
    await ensureOrderNoSchema(pool); // order_prefix column may be newer than the DB
    const { rows } = await pool.query(
      `select bank_cash, stock_units, stock_unit_cost,
              business_name, business_address, business_phone_1, business_phone_2,
              order_prefix, templates,
              courier_cost_base, courier_return_cost, courier_cost_overrides,
              gemini_api_key
       from business_settings where id = 1`
    );
    return rows[0] ? { ...DEFAULT_SETTINGS, ...(rows[0] as Partial<BusinessSettings>) } : DEFAULT_SETTINGS;
  }
  return g.__cyborgSettings ?? DEFAULT_SETTINGS;
}

export async function updateSettings(settings: BusinessSettings): Promise<BusinessSettings> {
  if (pool) {
    await ensureOrderNoSchema(pool);
    await pool.query(
      `insert into business_settings
         (id, bank_cash, stock_units, stock_unit_cost,
          business_name, business_address, business_phone_1, business_phone_2, order_prefix, templates,
          courier_cost_base, courier_return_cost, courier_cost_overrides, gemini_api_key)
       values (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (id) do update set
         bank_cash = excluded.bank_cash,
         stock_units = excluded.stock_units,
         stock_unit_cost = excluded.stock_unit_cost,
         business_name = excluded.business_name,
         business_address = excluded.business_address,
         business_phone_1 = excluded.business_phone_1,
         business_phone_2 = excluded.business_phone_2,
         order_prefix = excluded.order_prefix,
         templates = excluded.templates,
         courier_cost_base = excluded.courier_cost_base,
         courier_return_cost = excluded.courier_return_cost,
         courier_cost_overrides = excluded.courier_cost_overrides,
         gemini_api_key = excluded.gemini_api_key`,
      [
        settings.bank_cash,
        settings.stock_units,
        settings.stock_unit_cost,
        settings.business_name,
        settings.business_address,
        settings.business_phone_1,
        settings.business_phone_2,
        settings.order_prefix || "DC",
        JSON.stringify(settings.templates ?? {}),
        settings.courier_cost_base,
        settings.courier_return_cost,
        JSON.stringify(settings.courier_cost_overrides ?? {}),
        settings.gemini_api_key ?? "",
      ]
    );
    return settings;
  }
  g.__cyborgSettings = settings;
  return settings;
}
