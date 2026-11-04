import assert from "node:assert/strict";
import test from "node:test";

delete process.env.DATABASE_URL;
const db = await import("../lib/db.ts");

const order = (n) => ({
  customer_name: `Paging ${n}`,
  phone_number: `07700000${String(n).padStart(2, "0")}`,
  phone_2: "",
  raw_address: "a long pasted chat message",
  parsed_address: "1 Road",
  city: "Kandy",
  city_id: null,
  district: "Kandy",
  product_id: null,
  item_name: "Thing",
  items: null,
  product_price: 1000,
  shipping_fee: 350,
  discount: 0,
  total_cod: 1350,
});

test("orders page keeps every open order even past the history limit", async () => {
  const booked = await db.createOrder(order(1));
  await db.bookOrderOnce(booked.id, async () => ({ courier_name: "Mock", tracking_id: "PG-1", pdf_label_url: null }));
  const done = [];
  for (let i = 2; i <= 6; i++) {
    const o = await db.createOrder(order(i));
    await db.updateOrderStatus(o.id, "returned");
    done.push(o);
    await new Promise((r) => setTimeout(r, 2));
  }
  const { orders, total } = await db.listOrdersPage(2);
  const ids = orders.map((o) => o.id);
  assert.ok(ids.includes(booked.id), "an old in-flight order is always on screen");
  assert.ok(ids.includes(done[4].id) && ids.includes(done[3].id), "plus the newest history");
  assert.ok(!ids.includes(done[0].id), "older finished orders wait for 'load more'");
  assert.ok(total > orders.length);
});

test("only the newest checkpoint per order is sent to the list", async () => {
  const o = await db.createOrder(order(7));
  await db.addTrackingEvent(o.id, "Picked up", "in_transit");
  await new Promise((r) => setTimeout(r, 2));
  await db.addTrackingEvent(o.id, "Out for delivery", "in_transit");
  const latest = await db.listLatestTrackingEvents([o.id]);
  assert.equal(latest.length, 1);
  assert.equal(latest[0].checkpoint, "Out for delivery");
});
