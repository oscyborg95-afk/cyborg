import assert from "node:assert/strict";
import test from "node:test";

delete process.env.DATABASE_URL;
const db = await import("../lib/db.ts");

const order = (n) => ({
  customer_name: `Print ${n}`,
  phone_number: `07611100${String(n).padStart(2, "0")}`,
  phone_2: "",
  raw_address: "",
  parsed_address: "1 Road",
  city: "Galle",
  city_id: null,
  district: "Galle",
  product_id: null,
  item_name: "Thing",
  items: null,
  product_price: 1000,
  shipping_fee: 350,
  discount: 0,
  total_cod: 1350,
});

test("'not printed yet' holds every booked order until it is marked printed", async () => {
  const ids = [];
  for (let i = 1; i <= 4; i++) {
    const o = await db.createOrder(order(i));
    await db.bookOrderOnce(o.id, async () => ({ courier_name: "Mock", tracking_id: `PR-${o.id}`, pdf_label_url: null }));
    ids.push(o.id);
  }
  const pending = await db.createOrder(order(9)); // not dispatched → never on the list

  const unprinted = async () =>
    (await db.listInvoiceBatch({ from: null, to: null, unprinted: true, windowHours: 72 })).orders.map((o) => o.id);
  const before = await unprinted();
  assert.ok(ids.every((id) => before.includes(id)));
  assert.ok(!before.includes(pending.id));

  // Printed half of them today.
  const marked = await db.markInvoicesPrinted(ids.slice(0, 2), true);
  assert.equal(marked.length, 2);
  assert.ok(marked.every((m) => m.invoice_printed_at));
  const after = await unprinted();
  assert.deepEqual(ids.filter((id) => after.includes(id)), ids.slice(2), "only the unprinted half is left");

  // A date batch still shows printed ones, carrying their stamp for a reprint.
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  const day = await db.listInvoiceBatch({ from, to, windowHours: 72 });
  assert.ok(day.orders.find((o) => o.id === ids[0])?.invoice_printed_at);

  // Undo puts it back in the queue; delivered parcels leave it for good.
  await db.markInvoicesPrinted([ids[0]], false);
  assert.ok((await unprinted()).includes(ids[0]));
  await db.updateOrderStatus(ids[3], "delivered");
  assert.ok(!(await unprinted()).includes(ids[3]));
});

test("print history lists printed invoices, latest print run first", async () => {
  const ids = [];
  for (let i = 11; i <= 13; i++) {
    const o = await db.createOrder(order(i));
    await db.bookOrderOnce(o.id, async () => ({ courier_name: "Mock", tracking_id: `PH-${o.id}`, pdf_label_url: null }));
    ids.push(o.id);
  }
  await db.markInvoicesPrinted([ids[0], ids[1]], true);
  await new Promise((r) => setTimeout(r, 5));
  await db.markInvoicesPrinted([ids[2]], true);

  const history = (await db.listInvoiceBatch({ from: null, to: null, printed: true, windowHours: 72 })).orders;
  assert.ok(history.every((o) => o.invoice_printed_at), "only printed invoices");
  const pos = ids.map((id) => history.findIndex((o) => o.id === id));
  assert.ok(pos.every((p) => p >= 0));
  assert.ok(pos[2] < pos[0] && pos[2] < pos[1], "the later print run comes first");
  const first = history.find((o) => o.id === ids[0]);
  const second = history.find((o) => o.id === ids[1]);
  assert.equal(first.invoice_printed_at, second.invoice_printed_at, "one run shares one stamp");

  await db.markInvoicesPrinted([ids[0]], false);
  const after = (await db.listInvoiceBatch({ from: null, to: null, printed: true, windowHours: 72 })).orders;
  assert.ok(!after.some((o) => o.id === ids[0]), "undone prints leave the history");
});
