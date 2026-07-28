import assert from "node:assert/strict";
import test from "node:test";
import {
  claimDueTrackingNotifications,
  createManifest,
  createOrder,
  ingestDeliveryEvent,
  ingestCourierWebhook,
  listDeliveryAttempts,
  updateDeliveryAttempt,
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

test("delivery events project attempts, dedupe notifications, and record call outcomes", async () => {
  const order = await createOrder({
    customer_name: "Recovery Test",
    phone_number: "0771234568",
    phone_2: "",
    raw_address: "test",
    parsed_address: "test",
    city: "Horana",
    city_id: null,
    district: "Kalutara",
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
    tracking_id: "RECOVERY123",
    pdf_label_url: null,
    last_checkpoint: null,
  });
  const input = {
    event_key: "recovery-event-1",
    tracking_id: "RECOVERY123",
    status: "rescheduled",
    attempt_no: 2,
    reason: "Customer Phone No Answer. Reschedule Date : 2026-07-30",
    occurred_at: "2026-07-29T08:30:00.000Z",
    next_delivery_date: "2026-07-30",
    call_due_at: "2026-07-29T12:30:00.000Z",
    source: "poll",
    raw_payload: { status_name: "Rescheduled" },
    notifications: [
      {
        recipient: "customer",
        chat_id: "customer",
        body: "customer",
        notification_type: "customer_rescheduled",
        dedupe_key: `delivery:${order.id}:attempt:2:customer_rescheduled`,
      },
      {
        recipient: "owner",
        chat_id: "owner",
        body: "owner",
        notification_type: "owner_reschedule_alert",
        dedupe_key: `delivery:${order.id}:attempt:2:owner_reschedule_alert`,
      },
    ],
  };
  const first = await ingestDeliveryEvent(input);
  const duplicate = await ingestDeliveryEvent(input);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);

  const attempts = await listDeliveryAttempts();
  const attempt = attempts.find((item) => item.order_id === order.id);
  assert.ok(attempt);
  assert.equal(attempt.attempt_no, 2);
  assert.equal(attempt.next_delivery_date, "2026-07-30");
  assert.equal(attempt.call_status, "pending");

  const updated = await updateDeliveryAttempt({
    id: attempt.id,
    call_status: "called_confirmed",
    call_notes: "Customer confirmed",
  });
  assert.equal(updated?.call_status, "called_confirmed");
  assert.equal(updated?.call_notes, "Customer confirmed");
});
