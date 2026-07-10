import assert from "node:assert/strict";
import test from "node:test";

// Force the data layer's deterministic in-memory implementation. This exercises
// the same lock/idempotency paths used when Postgres is not configured.
delete process.env.DATABASE_URL;
const db = await import("../lib/db.ts");

const baseOrder = (productId) => ({
  customer_name: "Concurrency Test",
  phone_number: "0768846320",
  phone_2: "",
  raw_address: "45 Galle Road, Colombo 03",
  parsed_address: "45 Galle Road, Colombo 03",
  city: "Colombo 03",
  city_id: null,
  district: "Colombo",
  product_id: productId,
  item_name: "Test Item",
  items: [{ product_id: productId, name: "Test Item", qty: 1, price: 1000 }],
  product_price: 1000,
  shipping_fee: 350,
  discount: 0,
  total_cod: 1350,
});

test("dispatch retries reuse one order and one courier booking", async () => {
  const product = await db.createProduct({ name: "Test Item", price: 1000, unit_cost: 400, stock_units: 1 });
  const key = crypto.randomUUID();
  const [firstOrder, retriedOrder] = await Promise.all([
    db.createOrder(baseOrder(product.id), undefined, key),
    db.createOrder(baseOrder(product.id), undefined, key),
  ]);
  assert.equal(firstOrder.id, retriedOrder.id);

  let courierCalls = 0;
  const book = async () => {
    courierCalls++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { courier_name: "Mock Courier", tracking_id: "TRACK-1", pdf_label_url: null };
  };
  const [first, retry] = await Promise.all([
    db.bookOrderOnce(firstOrder.id, book),
    db.bookOrderOnce(firstOrder.id, book),
  ]);
  assert.equal(courierCalls, 1);
  assert.equal(first.manifest.id, retry.manifest.id);
  assert.deepEqual([first.reused, retry.reused].sort(), [false, true]);

  await Promise.all([
    db.updateOrderStatus(firstOrder.id, "returned"),
    db.updateOrderStatus(firstOrder.id, "returned"),
  ]);
  const stock = (await db.listProducts()).find((p) => p.id === product.id)?.stock_units;
  assert.equal(stock, 1, "a concurrent return must restore stock exactly once");

  await db.archiveOrder(firstOrder.id);
  assert.equal((await db.listOrders()).some((o) => o.id === firstOrder.id), false);
  assert.equal((await db.listOrders(true)).some((o) => o.id === firstOrder.id), true);
});

test("only one tracking sweep can hold the exclusive lock", async () => {
  const sweep = () => db.withExclusiveTrackingSync(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return "ran";
  });
  const results = await Promise.all([sweep(), sweep()]);
  assert.equal(results.filter((result) => result === "ran").length, 1);
  assert.equal(results.filter((result) => result === null).length, 1);
});
