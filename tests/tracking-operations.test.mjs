import assert from "node:assert/strict";
import test from "node:test";
import {
  claimDueTrackingNotifications,
  createManifest,
  createOrder,
  ingestCourierWebhook,
} from "../lib/db.ts";

test("webhook inbox is idempotent and enqueues each recipient once", async () => {
  const order = await createOrder({
    customer_name: "Webhook Test",
    phone_number: "0771234567",
    phone_2: "",
    raw_address: "test",
    parsed_address: "test",
    city: "Colombo",
    city_id: null,
    district: "Colombo",
    product_id: null,
    item_name: "Test",
    items: null,
    product_price: 0,
    shipping_fee: 0,
    discount: 0,
    total_cod: 0,
  });
  await createManifest({
    order_id: order.id,
    courier_name: "Test",
    tracking_id: "TEST1234",
    pdf_label_url: null,
    last_checkpoint: null,
  });
  const input = {
    fingerprint: "fingerprint-1",
    tracking_id: "TEST1234",
    status: "rescheduled",
    checkpoint: "Rescheduled — attempt 1",
    attempt: 1,
    payload: { waybill_id: "TEST1234", status: "rescheduled" },
    notifications: [
      { recipient: "customer", alert_kind: null, chat_id: "customer", body: "customer" },
      { recipient: "owner", alert_kind: null, chat_id: "owner", body: "owner" },
    ],
  };
  const first = await ingestCourierWebhook(input);
  const duplicate = await ingestCourierWebhook(input);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.event_id, first.event_id);
  const jobs = await claimDueTrackingNotifications();
  assert.equal(jobs.length, 2);
  assert.deepEqual(new Set(jobs.map((job) => job.recipient)), new Set(["customer", "owner"]));
});
