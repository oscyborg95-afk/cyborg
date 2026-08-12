import assert from "node:assert/strict";
import test from "node:test";
import {
  claimDueTrackingNotifications,
  createManifest,
  createOrder,
  getSettings,
  listOrderNotifications,
  recordCustomerDeliveryReply,
  updateSettings,
} from "../lib/db.ts";
import { processDeliveryEvent } from "../lib/delivery-workflow.ts";
import { normalizeWebhookEvent, parseRescheduleDate } from "../lib/delivery-events.ts";
import { parseCourierWebhook } from "../lib/courier-webhook.ts";

let sequence = 0;

// Owner alerts are only produced when the shop has an owner number configured.
test("configure the owner number the alerts are addressed to", async () => {
  await updateSettings({ ...(await getSettings()), business_phone_1: "0770000001" });
});

async function seedParcel(trackingId) {
  sequence += 1;
  const order = await createOrder({
    customer_name: `Dup Test ${sequence}`,
    phone_number: `07712345${String(sequence).padStart(2, "0")}`,
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
    tracking_id: trackingId,
    pdf_label_url: null,
    last_checkpoint: null,
  });
  return order;
}

function rescheduleEvent(trackingId, overrides = {}) {
  return {
    eventKey: `event-${Math.random()}`,
    trackingId,
    status: "rescheduled",
    attemptNo: 1,
    reason: "Customer phone no answer",
    occurredAt: new Date().toISOString(),
    nextDeliveryDate: null,
    raw: {
      status_name: "Rescheduled",
      status_created_at: new Date().toISOString(),
      remarks: "Customer phone no answer",
    },
    ...overrides,
  };
}

async function customerMessages(orderId) {
  const jobs = await listOrderNotifications(orderId);
  return jobs.filter((job) => job.notification_type === "customer_rescheduled");
}

test("one reschedule seen by both the webhook and the poller messages the customer once", async () => {
  const order = await seedParcel("DUP-BOTH-PATHS");

  // The webhook reports attempt 1 from a payload field; the poller re-derives
  // attempt 2 from courier history. Neither number may reach the dedupe key.
  await processDeliveryEvent(rescheduleEvent("DUP-BOTH-PATHS", { attemptNo: 1 }), "webhook");
  await processDeliveryEvent(rescheduleEvent("DUP-BOTH-PATHS", { attemptNo: 2 }), "poll");

  assert.equal((await customerMessages(order.id)).length, 1);
});

test("a courier that revises the delivery date daily still only messages the customer once", async () => {
  const order = await seedParcel("DUP-DATE-DRIFT");

  await processDeliveryEvent(
    rescheduleEvent("DUP-DATE-DRIFT", { nextDeliveryDate: "2026-08-20" }),
    "poll"
  );
  await processDeliveryEvent(
    rescheduleEvent("DUP-DATE-DRIFT", { nextDeliveryDate: "2026-08-21" }),
    "poll"
  );
  await processDeliveryEvent(
    rescheduleEvent("DUP-DATE-DRIFT", { nextDeliveryDate: "2026-08-22" }),
    "poll"
  );

  const messages = await customerMessages(order.id);
  assert.equal(messages.length, 1, "the cooldown collapses repeated revisions into one notice");

  // The owner is deliberately exempt: every new date is worth an alert.
  const ownerAlerts = (await listOrderNotifications(order.id)).filter(
    (job) => job.notification_type === "owner_reschedule_alert"
  );
  assert.ok(ownerAlerts.length >= 2, "owner still hears about each revised date");
});

test("a parcel returned to branch alerts the owner without messaging the customer", async () => {
  const order = await seedParcel("DUP-BRANCH");
  await processDeliveryEvent(
    rescheduleEvent("DUP-BRANCH", {
      status: "branch_rescheduled",
      nextDeliveryDate: "2026-09-01",
    }),
    "webhook"
  );
  const jobs = await listOrderNotifications(order.id);
  assert.equal(jobs.filter((job) => job.recipient === "customer").length, 0);
  assert.ok(jobs.some((job) => job.notification_type === "owner_reschedule_alert"));
});

test("both ingestion paths derive the same dedupe key from the same courier event", async () => {
  const order = await seedParcel("DUP-SHARED-KEY");
  // Webhook: the date sits in a nested field the old parser never looked at.
  const parsed = parseCourierWebhook({
    waybill_id: "DUP-SHARED-KEY",
    status: "Rescheduled",
    delivery_attempts: 2,
    detail: { comment: "Reschedule Date : 2026-08-30" },
  });
  const fromWebhook = normalizeWebhookEvent(parsed, "fingerprint-shared", [
    "Reschedule Date : 2026-08-30",
  ]);
  assert.equal(fromWebhook.nextDeliveryDate, "2026-08-30");

  await processDeliveryEvent(fromWebhook, "webhook");
  // Poller: same event, different attempt number, date written day-first.
  await processDeliveryEvent(
    rescheduleEvent("DUP-SHARED-KEY", {
      attemptNo: 4,
      nextDeliveryDate: "2026-08-30",
      reason: "No answer. Reschedule Date : 30/08/2026",
    }),
    "poll"
  );

  const messages = await customerMessages(order.id);
  assert.equal(messages.length, 1);
});

test("reschedule dates are read from every courier wording and format", () => {
  assert.equal(parseRescheduleDate("Reschedule Date : 2026-07-30"), "2026-07-30");
  assert.equal(
    parseRescheduleDate("Rescheduled - no answer. Reschedule Date : 2026-07-30"),
    "2026-07-30",
    "the label appearing twice must not hide the date"
  );
  assert.equal(parseRescheduleDate("Next Delivery Date - 30/07/2026"), "2026-07-30");
  assert.equal(parseRescheduleDate("Rescheduled to 2026.07.30"), "2026-07-30");
  assert.equal(parseRescheduleDate("Re-Delivery 30-07-2026"), "2026-07-30");
  // A date that is not a delivery date must never be adopted.
  assert.equal(parseRescheduleDate("Out for delivery 2026-07-30"), null);
  assert.equal(parseRescheduleDate("Customer not at home"), null);
  // Nonsense dates are rejected rather than silently normalised.
  assert.equal(parseRescheduleDate("Reschedule Date : 2026-02-31"), null);
});

test("a customer reply is attached to their open delivery attempt", async () => {
  const order = await seedParcel("DUP-REPLY");
  await processDeliveryEvent(
    rescheduleEvent("DUP-REPLY", { nextDeliveryDate: "2026-08-25" }),
    "poll"
  );

  const attempt = await recordCustomerDeliveryReply(
    order.phone_number,
    "Yes please deliver tomorrow after 10am"
  );
  assert.ok(attempt, "the reply lands on the open attempt");
  assert.equal(attempt.customer_reply, "Yes please deliver tomorrow after 10am");
  assert.ok(attempt.customer_replied_at);
  // Recording a reply must not decide the outcome for the operator.
  assert.equal(attempt.call_status, "pending");

  assert.equal(await recordCustomerDeliveryReply("0770000000", "hello"), null);
  assert.equal(await recordCustomerDeliveryReply(order.phone_number, "   "), null);
});

test("claimed notification jobs carry the id used as the send idempotency key", async () => {
  const order = await seedParcel("DUP-CLAIM");
  await processDeliveryEvent(rescheduleEvent("DUP-CLAIM"), "poll");
  const jobs = await claimDueTrackingNotifications(50);
  const mine = jobs.filter((job) => job.order_id === order.id);
  assert.ok(mine.length > 0);
  for (const job of mine) assert.ok(job.id, "every job needs a stable id to dedupe retries");
});
