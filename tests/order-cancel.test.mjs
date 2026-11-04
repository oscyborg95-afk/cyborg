import assert from "node:assert/strict";
import test from "node:test";

// In-memory data layer — same rules as Postgres, no database needed.
delete process.env.DATABASE_URL;
const db = await import("../lib/db.ts");
const { findDuplicates, duplicateOrderIds } = await import("../lib/risk.ts");
const { computeMetrics } = await import("../lib/metrics.ts");

const order = (productId, phone = "0771234567") => ({
  customer_name: "Cancel Test",
  phone_number: phone,
  phone_2: "",
  raw_address: "12 Temple Road, Kandy",
  parsed_address: "12 Temple Road, Kandy",
  city: "Kandy",
  city_id: null,
  district: "Kandy",
  product_id: productId,
  item_name: "Cream",
  items: [{ product_id: productId, name: "Cream", qty: 2, price: 1000 }],
  product_price: 2000,
  shipping_fee: 350,
  discount: 0,
  total_cod: 2350,
});

const mockBook = (id) => async () => ({ courier_name: "Mock", tracking_id: `TRK-${id}`, pdf_label_url: null });

test("cancelling a booked order puts its stock back and records why", async () => {
  const product = await db.createProduct({ name: "Cream", price: 1000, unit_cost: 300, stock_units: 10 });
  const created = await db.createOrder(order(product.id));
  await db.bookOrderOnce(created.id, mockBook(created.id));
  const stockOf = async () => (await db.listProducts()).find((p) => p.id === product.id)?.stock_units;
  assert.equal(await stockOf(), 8, "booking takes 2 units out");

  const cancelled = await db.cancelOrder(created.id, "  Customer cancelled  ");
  assert.equal(cancelled.order_status, "cancelled");
  assert.equal(cancelled.cancel_reason, "Customer cancelled");
  assert.ok(cancelled.cancelled_at);
  assert.equal(await stockOf(), 10, "cancel returns both units");

  await assert.rejects(db.cancelOrder(created.id, "again"), db.OrderCancelConflictError);
  assert.equal(await stockOf(), 10, "a second cancel must not restock twice");

  // Undo: back to booked takes the stock out again and clears the stamp.
  await db.updateOrderStatus(created.id, "booked");
  const restored = await db.getOrder(created.id);
  assert.equal(restored.order_status, "booked");
  assert.equal(restored.cancelled_at, null);
  assert.equal(await stockOf(), 8);
});

test("delivered and returned orders cannot be cancelled", async () => {
  const product = await db.createProduct({ name: "Cream", price: 1000, unit_cost: 300, stock_units: 10 });
  const created = await db.createOrder(order(product.id, "0712223334"));
  await db.bookOrderOnce(created.id, mockBook(created.id));
  await db.updateOrderStatus(created.id, "delivered");
  await assert.rejects(db.cancelOrder(created.id, "late"), db.OrderCancelConflictError);
});

test("invoice batch returns cancelled orders flagged, plus pending duplicate neighbours", async () => {
  const product = await db.createProduct({ name: "Cream", price: 1000, unit_cost: 300, stock_units: 50 });
  const phone = "0759998887";
  const first = await db.createOrder(order(product.id, phone));
  const twin = await db.createOrder(order(product.id, `+94${phone.slice(1)}`));
  const pendingTwin = await db.createOrder(order(product.id, phone));
  await db.bookOrderOnce(first.id, mockBook(first.id));
  await db.bookOrderOnce(twin.id, mockBook(twin.id));

  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  const batch = await db.listInvoiceBatch({ from, to, windowHours: 72 });
  const ids = batch.orders.map((o) => o.id);
  assert.ok(ids.includes(first.id) && ids.includes(twin.id));
  assert.ok(!ids.includes(pendingTwin.id), "unbooked orders are not printable");
  assert.ok(batch.related.some((o) => o.id === pendingTwin.id), "the pending twin comes back as context");
  assert.equal(batch.manifests.length, batch.orders.length);

  const pool = [...batch.orders, ...batch.related];
  const matches = findDuplicates(pool, batch.orders.find((o) => o.id === twin.id));
  assert.ok(matches.some((m) => m.order.id === first.id && m.sameItem));

  await db.cancelOrder(twin.id, "Duplicate order");
  const after = await db.listInvoiceBatch({ from, to, windowHours: 72 });
  assert.equal(after.orders.find((o) => o.id === twin.id)?.order_status, "cancelled");
  const live = after.orders.filter((o) => o.order_status !== "cancelled");
  assert.equal(duplicateOrderIds(live).has(twin.id), false, "a cancelled order is no longer a duplicate");
});

test("cancelled orders never count as shipped in metrics", () => {
  const now = new Date().toISOString();
  const base = { ...order(null), sales_account_id: "a", remitted_at: null, archived_at: null, created_at: now };
  const orders = [
    { ...base, id: "o1", order_status: "booked" },
    { ...base, id: "o2", order_status: "cancelled" },
  ];
  const manifests = orders.map((o) => ({
    id: `m-${o.id}`, order_id: o.id, courier_name: "Mock", tracking_id: `T-${o.id}`,
    pdf_label_url: null, last_checkpoint: null, created_at: now,
  }));
  const settings = { courier_cost_base: 350, courier_return_cost: 200, courier_cost_overrides: {} };
  const metrics = computeMetrics(orders, manifests, settings);
  assert.equal(metrics.totalPackages, 1);
  assert.equal(metrics.shippedToday, 1);
});
