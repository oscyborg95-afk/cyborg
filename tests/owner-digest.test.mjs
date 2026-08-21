import assert from "node:assert/strict";
import test, { before } from "node:test";
import {
  claimDueTrackingNotifications,
  createManifest,
  createOrder,
  ingestDeliveryEvent,
  getSettings,
  listAttemptsForDigestDate,
  updateSettings,
} from "../lib/db.ts";
import { buildDigestBody, colomboDate, queueOwnerDigest } from "../lib/owner-digest.ts";
import { processDeliveryEvent } from "../lib/delivery-workflow.ts";

// Owner-facing notifications are skipped entirely when no owner number is
// configured, so every test here needs one.
before(async () => {
  await updateSettings({ ...(await getSettings()), business_phone_1: "0771111111" });
});

const baseOrder = (name, phone) => ({
  customer_name: name,
  phone_number: phone,
  phone_2: "",
  raw_address: "test",
  parsed_address: "test",
  city: "Colombo",
  city_id: null,
  district: "Colombo",
  product_id: null,
  item_name: "Test",
  items: null,
  product_price: 2500,
  shipping_fee: 400,
  discount: 0,
  total_cod: 2900,
});

async function trackedOrder(name, phone, trackingId) {
  const order = await createOrder(baseOrder(name, phone));
  await createManifest({
    order_id: order.id,
    courier_name: "Test",
    tracking_id: trackingId,
    pdf_label_url: null,
    last_checkpoint: null,
  });
  return order;
}

test("one digest replaces a per-parcel morning blast", async () => {
  const today = colomboDate();
  const parcels = [
    ["Nimal Perera", "0770000001", "DIGEST0001", 3],
    ["Kamala Silva", "0770000002", "DIGEST0002", 1],
    ["Sunil Fernando", "0770000003", "DIGEST0003", 2],
  ];
  for (const [name, phone, tracking, attempt] of parcels) {
    const order = await trackedOrder(name, phone, tracking);
    await ingestDeliveryEvent({
      event_key: `digest-${tracking}`,
      tracking_id: tracking,
      status: "rescheduled",
      attempt_no: attempt,
      reason: "No answer",
      occurred_at: new Date().toISOString(),
      next_delivery_date: today,
      call_due_at: null,
      source: "poll",
      raw_payload: { status_name: "Rescheduled" },
      notifications: [],
    });
    assert.ok(order.id);
  }

  const rows = (await listAttemptsForDigestDate(today)).filter((row) =>
    row.tracking_id.startsWith("DIGEST")
  );
  assert.equal(rows.length, 3);

  const body = buildDigestBody("morning", today, rows, []);
  for (const [name, , tracking] of parcels) {
    assert.match(body, new RegExp(tracking));
    assert.match(body, new RegExp(name));
  }
  assert.match(body, /3 parcels scheduled/);
  // Highest attempt first: the parcel one step from being returned.
  assert.ok(body.indexOf("DIGEST0001") < body.indexOf("DIGEST0002"));
  assert.match(body, /🚨 DIGEST0001/);
  assert.match(body, /attempt 3 \(next: 4\)/);
});

test("the digest is sent once per day however often the cron drains", async () => {
  const today = colomboDate();
  const tracking = "DIGESTONCE1";
  await trackedOrder("Repeat Guard", "0770000009", tracking);
  await ingestDeliveryEvent({
    event_key: `digest-once-${tracking}`,
    tracking_id: tracking,
    status: "rescheduled",
    attempt_no: 2,
    reason: "No answer",
    occurred_at: new Date().toISOString(),
    next_delivery_date: today,
    call_due_at: null,
    source: "poll",
    raw_payload: { status_name: "Rescheduled" },
    notifications: [],
  });

  const first = await queueOwnerDigest("morning");
  const second = await queueOwnerDigest("morning");
  assert.equal(first.queued, true);
  assert.equal(second.queued, false);

  const jobs = await claimDueTrackingNotifications(50);
  const digests = jobs.filter((job) => job.notification_type === "owner_morning_digest");
  assert.equal(digests.length, 1);
});

test("a reschedule alerts immediately but queues no per-parcel reminders", async () => {
  const tracking = "IMMEDIATE01";
  await trackedOrder("Immediate Case", "0770000004", tracking);
  await processDeliveryEvent(
    {
      eventKey: "immediate-reschedule-1",
      trackingId: tracking,
      status: "rescheduled",
      attemptNo: 2,
      reason: "Customer not at home. Reschedule Date : 2099-01-05",
      occurredAt: new Date().toISOString(),
      nextDeliveryDate: "2099-01-05",
      raw: { status_name: "Rescheduled", status_created_at: "2099-01-02 10:00:00", remarks: "" },
    },
    "poll"
  );
  const jobs = await claimDueTrackingNotifications(50);
  const types = jobs.map((job) => job.notification_type);
  assert.ok(types.includes("owner_reschedule_alert"));
  assert.ok(!types.includes("owner_call_reminder"));
  assert.ok(!types.includes("owner_morning_reminder"));
});

test("a return still alerts immediately, in its own red-alert format", async () => {
  const tracking = "RETURNRED01";
  await trackedOrder("Returned Case", "0770000005", tracking);
  await processDeliveryEvent(
    {
      eventKey: "return-red-1",
      trackingId: tracking,
      status: "returned_to_ho",
      attemptNo: 3,
      reason: "Three failed attempts",
      occurredAt: new Date().toISOString(),
      nextDeliveryDate: null,
      raw: { status_name: "Returned to HO", status_created_at: "2099-01-06 10:00:00", remarks: "" },
    },
    "poll"
  );
  const jobs = await claimDueTrackingNotifications(50);
  const alert = jobs.find((job) => job.notification_type === "owner_terminal_return");
  assert.ok(alert, "return alert must not wait for a digest");
  assert.match(alert.body, /🔴🔴🔴 PARCEL RETURNED/);
  assert.match(alert.body, /RETURNRED01/);
  assert.match(alert.body, /Returned Case/);
  assert.match(alert.body, /COD value lost: Rs\. 2,900/);
});
