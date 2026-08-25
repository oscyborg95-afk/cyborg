import assert from "node:assert/strict";
import test from "node:test";
import {
  claimDueTrackingNotifications,
  createManifest,
  createOrder,
  updateOrderStatus,
} from "../lib/db.ts";
import {
  announcementBatchPrefix,
  EmptyAnnouncementBodyError,
  getAnnouncementProgress,
  groupCandidates,
  listAnnouncementRecipients,
  queueAnnouncement,
  renderAnnouncement,
} from "../lib/announcements.ts";
import { processTrackingNotificationQueue } from "../lib/tracking-notifications.ts";

const baseOrder = (name, phone, total = 1340) => ({
  customer_name: name,
  phone_number: phone,
  phone_2: "",
  raw_address: "test",
  parsed_address: "test",
  city: "Galle",
  city_id: null,
  district: "Galle",
  product_id: null,
  item_name: "Test",
  items: null,
  product_price: total - 340,
  shipping_fee: 340,
  discount: 0,
  total_cod: total,
});

async function bookedOrder(name, phone, trackingId, total = 1340) {
  const order = await createOrder(baseOrder(name, phone, total));
  await createManifest({
    order_id: order.id,
    courier_name: "Trans Express",
    tracking_id: trackingId,
    pdf_label_url: null,
  });
  await updateOrderStatus(order.id, "booked");
  return order;
}

test("one customer with two parcels is one recipient, not two", () => {
  const recipients = groupCandidates([
    {
      order_id: "a", order_no: "DC-1", customer_name: "Nimali Silva",
      phone_number: "0771234567", city: "Galle", district: "Galle", total_cod: 1340,
      order_status: "booked", tracking_id: "BE1", courier_name: "TE",
      booked_at: "2026-08-24T00:00:00.000Z", last_message_at: null,
    },
    {
      order_id: "b", order_no: "DC-2", customer_name: "Nimali Silva",
      phone_number: "94771234567", city: "Galle", district: "Galle", total_cod: 1990,
      order_status: "pending", tracking_id: null, courier_name: null,
      booked_at: "2026-08-20T00:00:00.000Z", last_message_at: "2026-08-24T06:00:00.000Z",
    },
  ]);

  assert.equal(recipients.length, 1);
  const [only] = recipients;
  assert.deepEqual(only.order_nos, ["DC-1", "DC-2"]);
  assert.deepEqual(only.tracking_ids, ["BE1"]);
  // They will pay for both parcels, so the COD shown is the combined figure.
  assert.equal(only.total_cod, 3330);
  // The group carries the oldest parcel's date — the one waiting longest.
  assert.equal(only.booked_at, "2026-08-20T00:00:00.000Z");
  assert.equal(only.last_message_at, "2026-08-24T06:00:00.000Z");
});

test("a number too short to dial is dropped rather than queued", () => {
  const recipients = groupCandidates([
    {
      order_id: "a", order_no: "DC-9", customer_name: "Broken", phone_number: "0771",
      city: "", district: "", total_cod: 100, order_status: "booked",
      tracking_id: null, courier_name: null,
      booked_at: "2026-08-24T00:00:00.000Z", last_message_at: null,
    },
  ]);
  assert.deepEqual(recipients, []);
});

test("a line whose only placeholder is unresolved disappears", () => {
  const recipient = {
    phone_key: "771234567", phone_number: "0771234567", chat_id: "94771234567@s.whatsapp.net",
    customer_name: "Nimali Silva", city: "Galle", district: "Galle",
    order_ids: ["a"], order_nos: ["DC-1"], tracking_ids: [], total_cod: 1340,
    statuses: ["pending"], booked_at: "2026-08-24T00:00:00.000Z", last_message_at: null,
  };

  const body = renderAnnouncement(
    "ආයුබෝවන් {{name}}!\nOrder: {{order_no}}\nTracking: {{tracking}}\nCOD: Rs. {{total}}",
    recipient
  );

  assert.equal(body, "ආයුබෝවන් Nimali!\nOrder: DC-1\nCOD: Rs. 1340");
});

test("queues one message per customer and reports the batch progress", async () => {
  const phone = "0772000001";
  await bookedOrder("Kasun Perera", phone, "BE900001", 1340);
  await bookedOrder("Kasun Perera", phone, "BE900002", 1990);

  const recipients = await listAnnouncementRecipients(["booked"]);
  const target = recipients.find((r) => r.phone_key === "772000001");
  assert.ok(target, "the booked customer should be in the audience");
  assert.equal(target.order_ids.length, 2);

  const result = await queueAnnouncement({
    body: "නිවාඩු දින නිසා delivery නැහැ 🙏 Order: {{order_no}}",
    phoneKeys: [target.phone_key],
    audiences: ["booked"],
  });

  assert.equal(result.recipients, 1);
  assert.equal(result.queued, 1, "two parcels, one message");

  const progress = await getAnnouncementProgress(result.batch_id);
  assert.equal(progress.total, 1);
  assert.equal(progress.waiting, 1);
  assert.equal(progress.sent, 0);
});

test("a batch drain never claims another batch's jobs", async () => {
  const first = await bookedOrder("Batch One", "0772000002", "BE900003");
  const second = await bookedOrder("Batch Two", "0772000003", "BE900004");
  assert.ok(first.id && second.id);

  const batchA = await queueAnnouncement({
    body: "A", phoneKeys: ["772000002"], audiences: ["booked"],
  });
  const batchB = await queueAnnouncement({
    body: "B", phoneKeys: ["772000003"], audiences: ["booked"],
  });

  const claimed = await claimDueTrackingNotifications(10, announcementBatchPrefix(batchA.batch_id));

  assert.equal(claimed.length, 1);
  assert.ok(claimed[0].dedupe_key.startsWith(announcementBatchPrefix(batchA.batch_id)));
  // Batch B is untouched and still waiting for its own drain.
  const progressB = await getAnnouncementProgress(batchB.batch_id);
  assert.equal(progressB.waiting, 1);
});

test("an order that gets delivered before its turn is skipped, not messaged", async () => {
  const order = await bookedOrder("Late Change", "0772000004", "BE900005");

  const batch = await queueAnnouncement({
    body: "Holiday notice", phoneKeys: ["772000004"], audiences: ["booked"],
  });

  // The courier delivers it while the operator is still sending the batch.
  await updateOrderStatus(order.id, "delivered");

  // No WhatsApp call is made: the guard short-circuits before the send.
  const result = await processTrackingNotificationQueue(5, announcementBatchPrefix(batch.batch_id));
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 0);

  const progress = await getAnnouncementProgress(batch.batch_id);
  assert.equal(progress.skipped, 1);
  assert.equal(progress.waiting, 0);
});

test("a message that renders blank is refused instead of quietly sent", async () => {
  // Confirmed but not yet booked, so there is no waybill to substitute.
  await createOrder(baseOrder("Blank Render", "0772000005"));

  // The whole message is one line and its only placeholder is a waybill this
  // order does not have — the line-drop rule would leave nothing to send.
  await assert.rejects(
    queueAnnouncement({
      body: "Holiday delay, tracking {{tracking}}",
      phoneKeys: ["772000005"],
      audiences: ["pending"],
    }),
    (err) => err instanceof EmptyAnnouncementBodyError && err.names.includes("Blank Render")
  );
});
