import { Pool, types } from "pg";
import { randomUUID } from "crypto";
import type {
  BusinessSettings,
  ChatState,
  ChatStateValue,
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
};

let pool: Pool | null = null;
if (DATABASE_URL) {
  pool = g.__cyborgPool ??= new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
  });
}

const memOrders = (g.__cyborgOrders ??= new Map<string, Order>());
const memManifests = (g.__cyborgManifests ??= new Map<string, ShippingManifest>());
const memChatStates = (g.__cyborgChatStates ??= new Map<string, ChatState>());
const memProducts = (g.__cyborgProducts ??= new Map<string, Product>());
const memTrackingEvents = (g.__cyborgTrackingEvents ??= []);

const DEFAULT_SETTINGS: BusinessSettings = {
  bank_cash: 0,
  stock_units: 0,
  stock_unit_cost: 155.83,
  business_name: "Daily Cart",
  business_address: "",
  business_phone_1: "",
  business_phone_2: "",
};

// --- Orders ------------------------------------------------------------------

export async function createOrder(input: NewOrder): Promise<Order> {
  if (pool) {
    const { rows } = await pool.query(
      `insert into orders
         (customer_name, phone_number, phone_2, raw_address, parsed_address, city, district,
          product_id, item_name, product_price, shipping_fee, discount, total_cod, order_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
       returning *`,
      [
        input.customer_name,
        input.phone_number,
        input.phone_2,
        input.raw_address,
        input.parsed_address,
        input.city,
        input.district,
        input.product_id,
        input.item_name,
        input.product_price,
        input.shipping_fee,
        input.discount,
        input.total_cod,
      ]
    );
    return rows[0] as Order;
  }
  const order: Order = {
    ...input,
    id: randomUUID(),
    order_status: "pending",
    created_at: new Date().toISOString(),
  };
  memOrders.set(order.id, order);
  return order;
}

export async function listOrders(): Promise<Order[]> {
  if (pool) {
    const { rows } = await pool.query(
      "select * from orders order by created_at desc limit 200"
    );
    return rows as Order[];
  }
  return [...memOrders.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getOrder(id: string): Promise<Order | null> {
  if (pool) {
    const { rows } = await pool.query("select * from orders where id = $1", [id]);
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

export async function updateOrderStatus(id: string, status: OrderStatus): Promise<void> {
  const order = await getOrder(id);
  if (!order) throw new Error("Order not found");
  const oldStatus = order.order_status;

  if (pool) {
    await pool.query("update orders set order_status = $1 where id = $2", [status, id]);
  } else {
    memOrders.set(id, { ...order, order_status: status });
  }

  // Keep the product's physical stock in sync with where the parcel is.
  if (order.product_id && oldStatus !== status) {
    const delta = STOCK_OUT[oldStatus] - STOCK_OUT[status];
    if (delta !== 0) await adjustProductStock(order.product_id, delta);
  }
}

// --- Shipping manifests ------------------------------------------------------

export async function createManifest(
  input: Omit<ShippingManifest, "id" | "created_at">
): Promise<ShippingManifest> {
  if (pool) {
    const { rows } = await pool.query(
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

export async function adjustProductStock(id: string, delta: number): Promise<void> {
  if (pool) {
    // Atomic: clamp at zero without a read-then-write race.
    await pool.query(
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
  outcome: string
): Promise<void> {
  if (pool) {
    try {
      await pool.query(
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
    const { rows } = await pool.query(
      `select bank_cash, stock_units, stock_unit_cost,
              business_name, business_address, business_phone_1, business_phone_2
       from business_settings where id = 1`
    );
    return rows[0] ? { ...DEFAULT_SETTINGS, ...(rows[0] as Partial<BusinessSettings>) } : DEFAULT_SETTINGS;
  }
  return g.__cyborgSettings ?? DEFAULT_SETTINGS;
}

export async function updateSettings(settings: BusinessSettings): Promise<BusinessSettings> {
  if (pool) {
    await pool.query(
      `insert into business_settings
         (id, bank_cash, stock_units, stock_unit_cost,
          business_name, business_address, business_phone_1, business_phone_2)
       values (1,$1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set
         bank_cash = excluded.bank_cash,
         stock_units = excluded.stock_units,
         stock_unit_cost = excluded.stock_unit_cost,
         business_name = excluded.business_name,
         business_address = excluded.business_address,
         business_phone_1 = excluded.business_phone_1,
         business_phone_2 = excluded.business_phone_2`,
      [
        settings.bank_cash,
        settings.stock_units,
        settings.stock_unit_cost,
        settings.business_name,
        settings.business_address,
        settings.business_phone_1,
        settings.business_phone_2,
      ]
    );
    return settings;
  }
  g.__cyborgSettings = settings;
  return settings;
}
