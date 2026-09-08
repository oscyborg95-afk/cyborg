import { randomUUID } from "node:crypto";
import Holidays from "date-holidays";
import { listAllOrders, listProducts, getSettings, queryDatabase, receiveProductStock, usingSupabase, withTransaction } from "./db.ts";
import { requireTenantSession } from "./tenant-context.ts";
import { phoneToChatId } from "./phone.ts";
import { sendWhatsAppMessage } from "./wa.ts";
import {
  analyzeReplenishment,
  automaticSendEligibility,
  civilDate,
  renderPurchaseMessage,
  type ClosureDay,
  type ReplenishmentAnalysis,
} from "./replenishment.ts";

export interface Supplier {
  id: string;
  name: string;
  whatsapp_phone: string;
  lead_time_working_days: number;
  working_weekdays: number[];
  active: boolean;
  automatic_send: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProductSupplierConfig {
  id: string;
  product_id: string;
  supplier_id: string;
  moq: number;
  pack_size: number;
  supplier_sku: string;
  unit_cost: number | null;
  preferred: boolean;
  target_cover_days: number;
  created_at: string;
  updated_at: string;
}

export interface CustomClosure {
  id: string;
  date: string;
  name: string;
  supplier_id: string | null;
  created_at: string;
  updated_at: string;
}

export type PurchaseOrderStatus = "draft" | "sent" | "confirmed" | "received" | "cancelled" | "failed";

export interface PurchaseOrderLine {
  id: string;
  purchase_order_id: string;
  product_id: string;
  product_name?: string;
  recommended_quantity: number;
  ordered_quantity: number;
  received_quantity: number;
  unit_cost: number | null;
}

export interface PurchaseOrder {
  id: string;
  reference: string;
  supplier_id: string;
  supplier_name?: string;
  status: PurchaseOrderStatus;
  recommendation_snapshot: Record<string, unknown>;
  message_body: string;
  expected_delivery_date: string;
  dedupe_key: string;
  automatic: boolean;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  received_at: string | null;
  error: string;
  lines: PurchaseOrderLine[];
}

interface MemoryStore {
  suppliers: Map<string, Supplier>;
  configs: Map<string, ProductSupplierConfig>;
  closures: Map<string, CustomClosure>;
  purchaseOrders: Map<string, PurchaseOrder>;
  receiptKeys: Set<string>;
  sequence: number;
  locks: Map<string, Promise<void>>;
}

const globalStore = globalThis as unknown as { __replenishmentStore?: MemoryStore; __replenishmentReady?: Set<string> };
const mem: MemoryStore = (globalStore.__replenishmentStore ??= {
  suppliers: new Map(),
  configs: new Map(),
  closures: new Map(),
  purchaseOrders: new Map(),
  receiptKeys: new Set(),
  sequence: 1000,
  locks: new Map(),
});

export async function ensureReplenishmentSchema(): Promise<void> {
  if (!usingSupabase) return;
  const tenantId = (await requireTenantSession()).tenantId;
  const ready = (globalStore.__replenishmentReady ??= new Set());
  if (ready.has(tenantId)) return;
  await queryDatabase(`
    create sequence if not exists purchase_order_number_seq start 1001;
    create table if not exists suppliers (
      id uuid primary key default gen_random_uuid(), name varchar not null,
      whatsapp_phone varchar not null, lead_time_working_days int not null default 1,
      working_weekdays jsonb not null default '[1,2,3,4,5,6]'::jsonb,
      active boolean not null default true, automatic_send boolean not null default false,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create table if not exists product_supplier_configs (
      id uuid primary key default gen_random_uuid(), product_id uuid not null references products(id) on delete cascade,
      supplier_id uuid not null references suppliers(id) on delete cascade, moq int not null default 1,
      pack_size int not null default 1, supplier_sku varchar not null default '', unit_cost numeric,
      preferred boolean not null default false, target_cover_days int not null default 14,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique(product_id, supplier_id)
    );
    create unique index if not exists uq_product_preferred_supplier on product_supplier_configs(product_id) where preferred;
    create table if not exists courier_closures (
      id uuid primary key default gen_random_uuid(), date date not null, name varchar not null,
      supplier_id uuid references suppliers(id) on delete cascade,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      unique(date, supplier_id)
    );
    create index if not exists idx_courier_closures_date on courier_closures(date);
    create table if not exists purchase_orders (
      id uuid primary key default gen_random_uuid(), reference varchar not null unique,
      supplier_id uuid not null references suppliers(id), status varchar not null default 'draft',
      recommendation_snapshot jsonb not null default '{}'::jsonb, message_body text not null default '',
      expected_delivery_date date not null, dedupe_key varchar not null unique, automatic boolean not null default false,
      sent_at timestamptz, received_at timestamptz, error text not null default '',
      created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create index if not exists idx_purchase_orders_status on purchase_orders(status, created_at desc);
    create table if not exists purchase_order_lines (
      id uuid primary key default gen_random_uuid(), purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
      product_id uuid not null references products(id), recommended_quantity int not null,
      ordered_quantity int not null, received_quantity int not null default 0, unit_cost numeric,
      unique(purchase_order_id, product_id)
    );
    create index if not exists idx_purchase_order_lines_product on purchase_order_lines(product_id);
    create table if not exists purchase_order_receipts (
      id uuid primary key default gen_random_uuid(), purchase_order_line_id uuid not null references purchase_order_lines(id) on delete cascade,
      idempotency_key varchar not null, quantity int not null, unit_cost numeric not null,
      created_at timestamptz not null default now(), unique(purchase_order_line_id, idempotency_key)
    );
  `);
  ready.add(tenantId);
}

function rowSupplier(row: Record<string, unknown>): Supplier {
  return { ...(row as unknown as Supplier), working_weekdays: Array.isArray(row.working_weekdays) ? row.working_weekdays.map(Number) : [1, 2, 3, 4, 5, 6] };
}

export async function listSuppliers(): Promise<Supplier[]> {
  if (!usingSupabase) return [...mem.suppliers.values()].sort((a, b) => a.name.localeCompare(b.name));
  await ensureReplenishmentSchema();
  const result = await queryDatabase("select * from suppliers order by active desc,name");
  return result.rows.map(rowSupplier);
}

export async function saveSupplier(input: Omit<Supplier, "id" | "created_at" | "updated_at"> & { id?: string }): Promise<Supplier> {
  const now = new Date().toISOString();
  if (!usingSupabase) {
    const supplier: Supplier = { ...input, id: input.id ?? randomUUID(), created_at: input.id ? mem.suppliers.get(input.id)?.created_at ?? now : now, updated_at: now };
    mem.suppliers.set(supplier.id, supplier);
    return supplier;
  }
  await ensureReplenishmentSchema();
  const result = input.id
    ? await queryDatabase(`update suppliers set name=$2,whatsapp_phone=$3,lead_time_working_days=$4,working_weekdays=$5::jsonb,active=$6,automatic_send=$7,updated_at=now() where id=$1 returning *`, [input.id, input.name, input.whatsapp_phone, input.lead_time_working_days, JSON.stringify(input.working_weekdays), input.active, input.automatic_send])
    : await queryDatabase(`insert into suppliers(name,whatsapp_phone,lead_time_working_days,working_weekdays,active,automatic_send) values($1,$2,$3,$4::jsonb,$5,$6) returning *`, [input.name, input.whatsapp_phone, input.lead_time_working_days, JSON.stringify(input.working_weekdays), input.active, input.automatic_send]);
  if (!result.rows[0]) throw new Error("Supplier not found");
  return rowSupplier(result.rows[0]);
}

export async function deleteSupplier(id: string): Promise<void> {
  if (!usingSupabase) { mem.suppliers.delete(id); for (const [key, value] of mem.configs) if (value.supplier_id === id) mem.configs.delete(key); return; }
  await ensureReplenishmentSchema();
  await queryDatabase("delete from suppliers where id=$1", [id]);
}

export async function listProductConfigs(): Promise<ProductSupplierConfig[]> {
  if (!usingSupabase) return [...mem.configs.values()];
  await ensureReplenishmentSchema();
  return (await queryDatabase("select * from product_supplier_configs order by preferred desc,created_at")).rows as unknown as ProductSupplierConfig[];
}

export async function saveProductConfig(input: Omit<ProductSupplierConfig, "id" | "created_at" | "updated_at">): Promise<ProductSupplierConfig> {
  const now = new Date().toISOString();
  if (!usingSupabase) {
    if (input.preferred) for (const [key, value] of mem.configs) if (value.product_id === input.product_id) mem.configs.set(key, { ...value, preferred: false });
    const existing = [...mem.configs.values()].find((item) => item.product_id === input.product_id && item.supplier_id === input.supplier_id);
    const config = { ...input, id: existing?.id ?? randomUUID(), created_at: existing?.created_at ?? now, updated_at: now };
    mem.configs.set(config.id, config);
    return config;
  }
  await ensureReplenishmentSchema();
  return withTransaction(async (db) => {
    if (!db) throw new Error("Database unavailable");
    if (input.preferred) await db.query("update product_supplier_configs set preferred=false where product_id=$1", [input.product_id]);
    const { rows } = await db.query(`insert into product_supplier_configs(product_id,supplier_id,moq,pack_size,supplier_sku,unit_cost,preferred,target_cover_days) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(product_id,supplier_id) do update set moq=excluded.moq,pack_size=excluded.pack_size,supplier_sku=excluded.supplier_sku,unit_cost=excluded.unit_cost,preferred=excluded.preferred,target_cover_days=excluded.target_cover_days,updated_at=now() returning *`, [input.product_id, input.supplier_id, input.moq, input.pack_size, input.supplier_sku, input.unit_cost, input.preferred, input.target_cover_days]);
    return rows[0] as unknown as ProductSupplierConfig;
  });
}

export async function listClosures(): Promise<CustomClosure[]> {
  if (!usingSupabase) return [...mem.closures.values()].sort((a, b) => a.date.localeCompare(b.date));
  await ensureReplenishmentSchema();
  return (await queryDatabase("select * from courier_closures order by date")).rows as unknown as CustomClosure[];
}

export async function saveClosure(input: { id?: string; date: string; name: string; supplier_id?: string | null }): Promise<CustomClosure> {
  const now = new Date().toISOString();
  if (!usingSupabase) {
    const closure: CustomClosure = { id: input.id ?? randomUUID(), date: input.date, name: input.name, supplier_id: input.supplier_id ?? null, created_at: input.id ? mem.closures.get(input.id)?.created_at ?? now : now, updated_at: now };
    mem.closures.set(closure.id, closure); return closure;
  }
  await ensureReplenishmentSchema();
  const result = input.id
    ? await queryDatabase("update courier_closures set date=$2,name=$3,supplier_id=$4,updated_at=now() where id=$1 returning *", [input.id, input.date, input.name, input.supplier_id ?? null])
    : await queryDatabase("insert into courier_closures(date,name,supplier_id) values($1,$2,$3) returning *", [input.date, input.name, input.supplier_id ?? null]);
  if (!result.rows[0]) throw new Error("Closure not found");
  return result.rows[0] as unknown as CustomClosure;
}

export async function deleteClosure(id: string): Promise<void> {
  if (!usingSupabase) { mem.closures.delete(id); return; }
  await ensureReplenishmentSchema(); await queryDatabase("delete from courier_closures where id=$1", [id]);
}

export function sriLankaHolidays(fromDate: string, toDate: string): ClosureDay[] {
  const hd = new Holidays("LK");
  const years = new Set([Number(fromDate.slice(0, 4)), Number(toDate.slice(0, 4))]);
  const unique = new Map<string, ClosureDay>();
  for (const year of years) {
    for (const holiday of hd.getHolidays(year)) {
      const date = holiday.date.slice(0, 10);
      if (date < fromDate || date > toDate || !["public", "bank"].includes(holiday.type)) continue;
      unique.set(date, { date, name: holiday.name, source: "holiday" });
    }
  }
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function openInboundByProduct(): Promise<Map<string, number>> {
  if (!usingSupabase) {
    const totals = new Map<string, number>();
    for (const po of mem.purchaseOrders.values()) if (["draft", "sent", "confirmed", "failed"].includes(po.status)) for (const line of po.lines) totals.set(line.product_id, (totals.get(line.product_id) ?? 0) + Math.max(0, line.ordered_quantity - line.received_quantity));
    return totals;
  }
  await ensureReplenishmentSchema();
  const rows = (await queryDatabase(`select l.product_id::text,sum(greatest(0,l.ordered_quantity-l.received_quantity))::int as units from purchase_order_lines l join purchase_orders p on p.id=l.purchase_order_id where p.status in ('draft','sent','confirmed','failed') group by l.product_id`)).rows;
  return new Map(rows.map((row) => [String(row.product_id), Number(row.units)]));
}

export async function getReplenishmentDashboard(now = new Date()): Promise<{
  generatedAt: string; sourceNote: string; analyses: ReplenishmentAnalysis[]; suppliers: Supplier[];
  configs: ProductSupplierConfig[]; closures: CustomClosure[]; holidays: ClosureDay[]; history: PurchaseOrder[];
}> {
  const [products, orders, suppliers, configs, customClosures, inbound, history] = await Promise.all([listProducts(), listAllOrders(), listSuppliers(), listProductConfigs(), listClosures(), openInboundByProduct(), listPurchaseOrders()]);
  const today = civilDate(now);
  const holidays = sriLankaHolidays(today, `${Number(today.slice(0, 4)) + 1}-12-31`);
  const demand = new Map<string, Map<string, number>>();
  for (const order of orders) {
    // Operational demand means parcels that actually left stock: booked or
    // fulfilled. Pending, returned, and replacement parcels are excluded.
    if (!["booked", "delivered"].includes(order.order_status) || order.payment_method === "replacement" || order.replaces_order_id) continue;
    const date = civilDate(new Date(order.created_at));
    const lines = order.items?.length ? order.items : order.product_id ? [{ product_id: order.product_id, qty: 1 }] : [];
    for (const line of lines) if (line.product_id && line.qty > 0) {
      const byDay = demand.get(line.product_id) ?? new Map<string, number>();
      byDay.set(date, (byDay.get(date) ?? 0) + line.qty); demand.set(line.product_id, byDay);
    }
  }
  const analyses = products.map((product) => {
    const config = configs.filter((item) => item.product_id === product.id).sort((a, b) => Number(b.preferred) - Number(a.preferred))[0];
    const supplier = suppliers.find((item) => item.id === config?.supplier_id && item.active);
    const closures: ClosureDay[] = [
      ...holidays,
      ...customClosures.filter((item) => !item.supplier_id || item.supplier_id === supplier?.id).map((item) => ({ date: item.date, name: item.name, source: "custom" as const })),
    ];
    return analyzeReplenishment({
      productId: product.id, productName: product.name, currentStock: product.stock_units, unitCost: config?.unit_cost ?? product.unit_cost,
      demand: [...(demand.get(product.id) ?? new Map()).entries()].map(([date, units]) => ({ date, units })), now,
      supplierConfigured: Boolean(config && supplier), supplierId: supplier?.id, supplierName: supplier?.name,
      leadTimeWorkingDays: supplier?.lead_time_working_days, workingWeekdays: supplier?.working_weekdays,
      closures, targetCoverDays: config?.target_cover_days, moq: config?.moq, packSize: config?.pack_size,
      openInboundUnits: inbound.get(product.id) ?? 0,
    });
  }).sort((a, b) => {
    const rank = { order_now: 0, setup_needed: 1, watch: 2, already_ordered: 3, no_demand_data: 4, healthy: 5 };
    return rank[a.status] - rank[b.status] || (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity);
  });
  return { generatedAt: now.toISOString(), sourceNote: "28-day shipped-order baseline; Sri Lanka public/bank calendar from date-holidays plus your courier closures.", analyses, suppliers, configs, closures: customClosures, holidays, history };
}

function hydrateOrders(rows: Record<string, unknown>[], lineRows: Record<string, unknown>[]): PurchaseOrder[] {
  return rows.map((row) => ({ ...(row as unknown as Omit<PurchaseOrder, "lines">), lines: lineRows.filter((line) => line.purchase_order_id === row.id) as unknown as PurchaseOrderLine[] }));
}

export async function listPurchaseOrders(): Promise<PurchaseOrder[]> {
  if (!usingSupabase) return [...mem.purchaseOrders.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  await ensureReplenishmentSchema();
  const [orders, lines] = await Promise.all([
    queryDatabase(`select p.*,s.name as supplier_name from purchase_orders p join suppliers s on s.id=p.supplier_id order by p.created_at desc limit 100`),
    queryDatabase(`select l.*,pr.name as product_name from purchase_order_lines l join products pr on pr.id=l.product_id`),
  ]);
  return hydrateOrders(orders.rows, lines.rows);
}

export async function createPurchaseOrder(input: { supplierId: string; lines: { productId: string; quantity: number }[]; messageBody?: string; automatic?: boolean; now?: Date }): Promise<{ order: PurchaseOrder; reused: boolean }> {
  const nowDate = input.now ?? new Date();
  const dashboard = await getReplenishmentDashboard(nowDate);
  const supplier = dashboard.suppliers.find((item) => item.id === input.supplierId && item.active);
  if (!supplier) throw new Error("Active supplier not found");
  const selected = input.lines.map((line) => {
    const analysis = dashboard.analyses.find((item) => item.productId === line.productId && item.supplierId === supplier.id);
    if (!analysis) throw new Error("Product is not assigned to this supplier");
    return { analysis, quantity: Math.max(1, Math.floor(line.quantity)) };
  });
  const cycle = civilDate(nowDate);
  const cycleKey = `replenishment:${cycle}:${supplier.id}:${selected.map((item) => item.analysis.productId).sort().join(",")}`;
  const expectedDeliveryDate = selected.map((item) => item.analysis.expectedArrivalDate).sort().at(-1)!;
  const reference = `PO-${cycle.replaceAll("-", "")}-${usingSupabase ? randomUUID().slice(0, 6).toUpperCase() : ++mem.sequence}`;
  const settings = await getSettings();
  const defaultMessage = renderPurchaseMessage({ supplierName: supplier.name, businessName: settings.business_name || "Our shop", reference, expectedDeliveryDate, lines: selected.map(({ analysis, quantity }) => ({ name: analysis.productName, quantity, supplierSku: dashboard.configs.find((item) => item.product_id === analysis.productId && item.supplier_id === supplier.id)?.supplier_sku })) });
  if (!usingSupabase) {
    const cycleOrders = [...mem.purchaseOrders.values()].filter((item) => item.dedupe_key === cycleKey || item.dedupe_key.startsWith(`${cycleKey}:r`));
    const existing = cycleOrders.find((item) => !["cancelled", "received"].includes(item.status));
    if (existing) return { order: existing, reused: true };
    const dedupeKey = cycleOrders.length === 0 ? cycleKey : `${cycleKey}:r${cycleOrders.length + 1}`;
    const timestamp = nowDate.toISOString();
    const id = randomUUID();
    const order: PurchaseOrder = { id, reference, supplier_id: supplier.id, supplier_name: supplier.name, status: "draft", recommendation_snapshot: Object.fromEntries(selected.map((item) => [item.analysis.productId, item.analysis])), message_body: input.messageBody?.trim() || defaultMessage, expected_delivery_date: expectedDeliveryDate, dedupe_key: dedupeKey, automatic: Boolean(input.automatic), created_at: timestamp, updated_at: timestamp, sent_at: null, received_at: null, error: "", lines: selected.map(({ analysis, quantity }) => ({ id: randomUUID(), purchase_order_id: id, product_id: analysis.productId, product_name: analysis.productName, recommended_quantity: analysis.recommendedQuantity, ordered_quantity: quantity, received_quantity: 0, unit_cost: analysis.unitCost })) };
    mem.purchaseOrders.set(id, order); return { order, reused: false };
  }
  await ensureReplenishmentSchema();
  return withTransaction(async (db) => {
    if (!db) throw new Error("Database unavailable");
    // Serialize a recommendation cycle across overlapping cron/manual runs.
    await db.query("select pg_advisory_xact_lock(hashtext($1))", [cycleKey]);
    const cycleOrders = await db.query("select p.*,s.name as supplier_name from purchase_orders p join suppliers s on s.id=p.supplier_id where p.dedupe_key=$1 or p.dedupe_key like $1 || ':r%' order by p.created_at", [cycleKey]);
    const duplicate = cycleOrders.rows.find((row) => !["cancelled", "received"].includes(String(row.status)));
    if (duplicate) {
      const lines = await db.query("select l.*,pr.name as product_name from purchase_order_lines l join products pr on pr.id=l.product_id where l.purchase_order_id=$1", [duplicate.id]);
      return { order: hydrateOrders([duplicate], lines.rows)[0], reused: true };
    }
    const dedupeKey = cycleOrders.rows.length === 0 ? cycleKey : `${cycleKey}:r${cycleOrders.rows.length + 1}`;
    const inserted = await db.query(`insert into purchase_orders(reference,supplier_id,recommendation_snapshot,message_body,expected_delivery_date,dedupe_key,automatic) values($1,$2,$3::jsonb,$4,$5,$6,$7) returning *`, [reference, supplier.id, JSON.stringify(Object.fromEntries(selected.map((item) => [item.analysis.productId, item.analysis]))), input.messageBody?.trim() || defaultMessage, expectedDeliveryDate, dedupeKey, Boolean(input.automatic)]);
    const po = inserted.rows[0];
    for (const { analysis, quantity } of selected) await db.query(`insert into purchase_order_lines(purchase_order_id,product_id,recommended_quantity,ordered_quantity,unit_cost) values($1,$2,$3,$4,$5)`, [po.id, analysis.productId, analysis.recommendedQuantity, quantity, analysis.unitCost]);
    const lines = await db.query("select l.*,pr.name as product_name from purchase_order_lines l join products pr on pr.id=l.product_id where l.purchase_order_id=$1", [po.id]);
    return { order: hydrateOrders([{ ...po, supplier_name: supplier.name }], lines.rows)[0], reused: false };
  });
}

export async function sendPurchaseOrder(id: string, editedMessage?: string): Promise<PurchaseOrder> {
  const orders = await listPurchaseOrders();
  const order = orders.find((item) => item.id === id);
  if (!order) throw new Error("Purchase request not found");
  if (order.status === "sent" || order.status === "confirmed" || order.status === "received") return order;
  const supplier = (await listSuppliers()).find((item) => item.id === order.supplier_id);
  if (!supplier) throw new Error("Supplier not found");
  const message = editedMessage?.trim() || order.message_body;
  try {
    await sendWhatsAppMessage(phoneToChatId(supplier.whatsapp_phone), message, undefined, undefined, undefined, `purchase-order:${order.id}`);
    const sentAt = new Date().toISOString();
    if (!usingSupabase) { const updated = { ...order, message_body: message, status: "sent" as const, sent_at: sentAt, updated_at: sentAt, error: "" }; mem.purchaseOrders.set(id, updated); return updated; }
    const result = await queryDatabase("update purchase_orders set message_body=$2,status='sent',sent_at=coalesce(sent_at,now()),error='',updated_at=now() where id=$1 returning *", [id, message]);
    return hydrateOrders([{ ...result.rows[0], supplier_name: supplier.name }], order.lines as unknown as Record<string, unknown>[])[0];
  } catch (error) {
    const messageText = error instanceof Error ? error.message : "WhatsApp send failed";
    if (!usingSupabase) { const failed = { ...order, message_body: message, status: "failed" as const, error: messageText, updated_at: new Date().toISOString() }; mem.purchaseOrders.set(id, failed); throw Object.assign(new Error(messageText), { purchaseOrder: failed }); }
    await queryDatabase("update purchase_orders set message_body=$2,status='failed',error=$3,updated_at=now() where id=$1", [id, message, messageText]);
    throw new Error(messageText);
  }
}

async function withMemoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = mem.locks.get(key) ?? Promise.resolve(); let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }); const tail = prior.then(() => gate); mem.locks.set(key, tail); await prior;
  try { return await fn(); } finally { release(); if (mem.locks.get(key) === tail) mem.locks.delete(key); }
}

export async function receivePurchaseOrder(id: string, receipts: { lineId: string; quantity: number; unitCost: number }[], idempotencyKey: string): Promise<PurchaseOrder> {
  if (!usingSupabase) return withMemoryLock(id, async () => {
    const order = mem.purchaseOrders.get(id); if (!order) throw new Error("Purchase request not found");
    let lines = order.lines;
    for (const receipt of receipts) {
      const line = lines.find((item) => item.id === receipt.lineId); if (!line) throw new Error("Purchase order line not found");
      const key = `${line.id}:${idempotencyKey}`; if (mem.receiptKeys.has(key)) continue;
      const quantity = Math.min(receipt.quantity, line.ordered_quantity - line.received_quantity); if (quantity <= 0) continue;
      const product = await receiveProductStock(line.product_id, quantity, receipt.unitCost, null);
      if (!product) throw new Error("Product not found while receiving stock");
      // Record dedupe only after stock moved successfully. A failed stock write
      // remains retryable instead of being incorrectly consumed.
      mem.receiptKeys.add(key);
      lines = lines.map((item) => item.id === line.id ? { ...item, received_quantity: item.received_quantity + quantity } : item);
    }
    const complete = lines.every((line) => line.received_quantity >= line.ordered_quantity); const timestamp = new Date().toISOString();
    const updated = { ...order, lines, status: complete ? "received" as const : order.status, received_at: complete ? timestamp : order.received_at, updated_at: timestamp };
    mem.purchaseOrders.set(id, updated); return updated;
  });
  await ensureReplenishmentSchema();
  return withTransaction(async (db) => {
    if (!db) throw new Error("Database unavailable");
    const poResult = await db.query("select * from purchase_orders where id=$1 for update", [id]); if (!poResult.rows[0]) throw new Error("Purchase request not found");
    for (const receipt of receipts) {
      const lineResult = await db.query("select * from purchase_order_lines where id=$1 and purchase_order_id=$2 for update", [receipt.lineId, id]); const line = lineResult.rows[0]; if (!line) throw new Error("Purchase order line not found");
      const quantity = Math.min(receipt.quantity, Number(line.ordered_quantity) - Number(line.received_quantity)); if (quantity <= 0) continue;
      const inserted = await db.query("insert into purchase_order_receipts(purchase_order_line_id,idempotency_key,quantity,unit_cost) values($1,$2,$3,$4) on conflict do nothing returning id", [line.id, idempotencyKey, quantity, receipt.unitCost]);
      if (!inserted.rows[0]) continue;
      await receiveProductStock(String(line.product_id), quantity, receipt.unitCost, db as never);
      await db.query("update purchase_order_lines set received_quantity=received_quantity+$2 where id=$1", [line.id, quantity]);
    }
    const pending = await db.query("select 1 from purchase_order_lines where purchase_order_id=$1 and received_quantity < ordered_quantity limit 1", [id]);
    if (!pending.rows[0]) await db.query("update purchase_orders set status='received',received_at=coalesce(received_at,now()),updated_at=now() where id=$1", [id]);
    const rows = await db.query("select p.*,s.name as supplier_name from purchase_orders p join suppliers s on s.id=p.supplier_id where p.id=$1", [id]);
    const lines = await db.query("select l.*,pr.name as product_name from purchase_order_lines l join products pr on pr.id=l.product_id where l.purchase_order_id=$1", [id]);
    return hydrateOrders(rows.rows, lines.rows)[0];
  });
}

export async function runAutomaticReplenishment(now = new Date()): Promise<{ created: number; sent: number; errors: string[] }> {
  const dashboard = await getReplenishmentDashboard(now); let created = 0; let sent = 0; const errors: string[] = [];
  for (const supplier of dashboard.suppliers.filter((item) => item.active && item.automatic_send)) {
    const due = dashboard.analyses.filter((item) => item.supplierId === supplier.id && automaticSendEligibility(item).eligible);
    if (!due.length) continue;
    try {
      const result = await createPurchaseOrder({ supplierId: supplier.id, automatic: true, now, lines: due.map((item) => ({ productId: item.productId, quantity: item.recommendedQuantity })) });
      if (!result.reused) created += 1;
      if (["draft", "failed"].includes(result.order.status)) { await sendPurchaseOrder(result.order.id); sent += 1; }
    } catch (error) { errors.push(`${supplier.name}: ${error instanceof Error ? error.message : "Automatic request failed"}`); }
  }
  return { created, sent, errors };
}
