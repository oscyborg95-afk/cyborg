import assert from "node:assert/strict";
import test from "node:test";

// In-memory data layer for the end-to-end cases below; never a real database.
delete process.env.DATABASE_URL;
const db = await import("../lib/db.ts");
const { processDeliveryEvent } = await import("../lib/delivery-workflow.ts");
const {
  canonicalWebhookStatus,
  courierCancelReason,
  extractPublicTrackingHistory,
  isRecentCourierEvent,
  normalizeCourierHistory,
  normalizeDeliveryStatus,
  orderStatusForDeliveryEvent,
  ownerCallDueAt,
  parseRescheduleDate,
} = await import("../lib/delivery-events.ts");

test("parses Trans Express public tracking sections", () => {
  const rows = extractPublicTrackingHistory({
    data: [
      { key: "order_details", value: [{ current_status: "Returned to Branch Rescheduled" }] },
      {
        key: "tracking_history",
        value: [
          {
            status_name: "Out for Delivery",
            status_created_at: "2026-07-23 09:24:01",
            remarks: "Assigned to Freelancer 05.",
          },
        ],
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status_name, "Out for Delivery");
});

test("builds three attempts and pairs reschedules with the active attempt", () => {
  const history = [
    {
      status_name: "Out for Delivery",
      status_created_at: "2026-07-23 09:24:01",
      remarks: "Assigned to Freelancer 05.",
    },
    {
      status_name: "Rescheduled",
      status_created_at: "2026-07-23 13:12:47",
      remarks: "Customer Phone No Answer.\nReschedule Date : 2026-07-24",
    },
    {
      status_name: "Returned to Branch Rescheduled",
      status_created_at: "2026-07-23 13:20:58",
      remarks: "Order returned to branch for rescheduling",
    },
    {
      status_name: "Out for Delivery",
      status_created_at: "2026-07-24 08:54:32",
      remarks: "Attempt 2\nAssigned to Freelancer 05.",
    },
    {
      status_name: "Rescheduled",
      status_created_at: "2026-07-24 14:00:46",
      remarks: "Customer Phone No Answer.\nReschedule Date : 2026-07-25",
    },
    {
      status_name: "Out for Delivery",
      status_created_at: "2026-07-25 09:39:38",
      remarks: "Attempt 3\nAssigned to Freelancer 05.",
    },
    {
      status_name: "Failed to Deliver",
      status_created_at: "2026-07-25 16:46:01",
      remarks: "Customer Refused",
    },
    {
      status_name: "Returned to Branch Failed",
      status_created_at: "2026-07-25 17:04:24",
      remarks: "Order returned to branch due to delivery failure",
    },
    {
      status_name: "Returned to HO",
      status_created_at: "2026-07-28 16:05:07",
      remarks: null,
    },
  ];
  const events = normalizeCourierHistory("BE415871", history);
  assert.deepEqual(
    events.map(({ status, attemptNo }) => [status, attemptNo]),
    [
      ["out_for_delivery", 1],
      ["rescheduled", 1],
      ["branch_rescheduled", 1],
      ["out_for_delivery", 2],
      ["rescheduled", 2],
      ["out_for_delivery", 3],
      ["failed_to_deliver", 3],
      ["branch_failed", 3],
      ["returned_to_ho", 3],
    ]
  );
  assert.equal(events[1].nextDeliveryDate, "2026-07-24");
  assert.equal(events[4].nextDeliveryDate, "2026-07-25");
  assert.equal(events[0].occurredAt, "2026-07-23T03:54:01.000Z");
  assert.equal(events[0].eventKey, normalizeCourierHistory("BE415871", history)[0].eventKey);
});

test("normalizes branch return states without treating a reschedule as terminal", () => {
  assert.equal(normalizeDeliveryStatus("Returned to Branch Rescheduled"), "branch_rescheduled");
  assert.equal(normalizeDeliveryStatus("Returned to Branch Failed"), "branch_failed");
  assert.equal(normalizeDeliveryStatus("Returned to HO"), "returned_to_ho");
  assert.equal(normalizeDeliveryStatus("Received at Destination"), null);
});

test("a partially delivered parcel is finished, and keeps its collected-COD remark", () => {
  assert.equal(normalizeDeliveryStatus("Partially Delivered"), "delivered");
  const [event] = normalizeCourierHistory("BG895879", [
    { status_name: "Out for Delivery", status_created_at: "2026-11-07 09:08:58", remarks: "Assigned to rider" },
    {
      status_name: "Partially Delivered",
      status_created_at: "2026-11-07 13:31:02",
      remarks: "Collected COD Rs. 1.00.  Requested by online store",
    },
  ]).slice(-1);
  assert.equal(event.status, "delivered");
  assert.equal(event.raw.status_name, "Partially Delivered");
  assert.match(event.reason, /Collected COD Rs\. 1\.00/);
});

test("extracts next date and schedules the previous-day 6 PM reminder", () => {
  assert.equal(
    parseRescheduleDate("Customer Phone No Answer. Reschedule Date : 2026-07-25"),
    "2026-07-25"
  );
  assert.equal(
    ownerCallDueAt(
      "2026-07-25",
      "2026-07-24T08:30:00.000Z",
      new Date("2026-07-24T08:31:00.000Z")
    ),
    "2026-07-24T12:30:00.000Z"
  );
});

test("same-day or unknown dates become immediate call tasks", () => {
  const now = new Date("2026-07-28T08:20:00.000Z");
  assert.equal(
    ownerCallDueAt("2026-07-28", "2026-07-28T08:12:24.000Z", now),
    now.toISOString()
  );
  assert.equal(ownerCallDueAt(null, "2026-07-28T08:12:24.000Z", now), now.toISOString());
});

// Trans Express voids any booking it has not collected within 14 days. This is
// the exact history the live parcels carried (only the waybill is invented).
const AUTO_CANCEL_REMARK = "Orders older than 14 day(s) have been canceled automatically.";
function autoCancelledHistory(processingAt, cancelledAt) {
  return [
    { status_name: "Processing", status_created_at: processingAt, remarks: "Enter by J-nex" },
    { status_name: "Cancelled", status_created_at: cancelledAt, remarks: AUTO_CANCEL_REMARK },
  ];
}

const courierTimestamp = (date) =>
  new Date(date.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");

test("a courier-cancelled booking is a terminal cancelled event, from either path", () => {
  assert.equal(normalizeDeliveryStatus("Cancelled"), "cancelled");
  assert.equal(normalizeDeliveryStatus("Canceled"), "cancelled");
  const events = normalizeCourierHistory(
    "BE472753",
    autoCancelledHistory("2026-07-27 11:00:11", "2026-08-11 00:01:35")
  );
  assert.deepEqual(events.map(({ status, attemptNo }) => [status, attemptNo]), [["cancelled", 1]]);
  assert.equal(events[0].reason, AUTO_CANCEL_REMARK);
  assert.equal(events[0].occurredAt, "2026-08-10T18:31:35.000Z");

  // The webhook used to call this a return to HO, which apologised to the
  // customer for a parcel that never left.
  assert.equal(canonicalWebhookStatus({ status: "cancelled", rawStatus: "Cancelled" }), "cancelled");
  assert.equal(canonicalWebhookStatus({ status: "cancelled", rawStatus: "" }), "cancelled");
  assert.equal(canonicalWebhookStatus({ status: "returned", rawStatus: "" }), "returned_to_ho");

  assert.equal(orderStatusForDeliveryEvent("cancelled"), "cancelled");
  assert.equal(orderStatusForDeliveryEvent("returned_to_ho"), "returned");
  assert.equal(orderStatusForDeliveryEvent("delivered"), "delivered");
  assert.equal(orderStatusForDeliveryEvent("rescheduled"), null);
  assert.equal(courierCancelReason(AUTO_CANCEL_REMARK), `Cancelled by courier: ${AUTO_CANCEL_REMARK}`);
  assert.equal(courierCancelReason(null), "Cancelled by courier");
});

test("only a recent courier cancellation is worth an owner alert", () => {
  const now = new Date("2026-11-19T06:00:00.000Z");
  assert.equal(isRecentCourierEvent("2026-11-17T06:00:00.000Z", now), true);
  assert.equal(isRecentCourierEvent("2026-11-15T06:00:00.000Z", now), false);
  assert.equal(isRecentCourierEvent("2026-08-10T18:31:35.000Z", now), false);
  assert.equal(isRecentCourierEvent("not a date", now), false);
});

async function seedBookedParcel(trackingId, phone, extra = {}) {
  const product = await db.createProduct({ name: `Patch ${trackingId}`, price: 1000, unit_cost: 300, stock_units: 10 });
  const order = await db.createOrder({
    customer_name: `Cancel ${trackingId}`,
    phone_number: phone,
    phone_2: "",
    raw_address: "53 Galle Road, Panadura",
    parsed_address: "53 Galle Road, Panadura",
    city: "Panadura",
    city_id: null,
    district: "Kalutara",
    product_id: product.id,
    item_name: "Pimple patches",
    items: [{ product_id: product.id, name: "Pimple patches", qty: 2, price: 500 }],
    product_price: 1000,
    shipping_fee: 340,
    discount: 0,
    total_cod: 1340,
    ...extra,
  });
  await db.bookOrderOnce(order.id, async () => ({
    courier_name: "Trans Express",
    tracking_id: trackingId,
    pdf_label_url: null,
  }));
  const stock = async () => (await db.listProducts()).find((p) => p.id === product.id)?.stock_units;
  assert.equal(await stock(), 8, "booking takes the units out");
  return { order, stock };
}

// The poller's loop, minus the courier fetch: replay the history and notify on
// the last event only.
async function replayPoll(trackingId, history) {
  const events = normalizeCourierHistory(trackingId, history);
  for (const [index, event] of events.entries()) {
    await processDeliveryEvent(event, "poll", index === events.length - 1);
  }
}

test("a months-old courier cancellation closes the order quietly and restocks it", async () => {
  await db.updateSettings({ ...(await db.getSettings()), business_phone_1: "0770000001" });
  const { order, stock } = await seedBookedParcel("CANCEL-OLD", "0771112201");
  const history = autoCancelledHistory("2026-07-27 11:00:11", "2026-08-11 00:01:35");
  await replayPoll("CANCEL-OLD", history);
  await replayPoll("CANCEL-OLD", history); // a second sync changes nothing

  const after = await db.getOrder(order.id);
  assert.equal(after.order_status, "cancelled");
  assert.equal(after.cancelled_at, "2026-08-10T18:31:35.000Z", "stamped with the courier's time");
  assert.equal(after.cancel_reason, `Cancelled by courier: ${AUTO_CANCEL_REMARK}`);
  assert.equal(await stock(), 10, "the units are back on the shelf");
  assert.deepEqual(await db.listOrderNotifications(order.id), [], "no WhatsApp to anyone");
  const inFlight = await db.listInFlightTrackedOrders();
  assert.ok(!inFlight.some((tracked) => tracked.order.id === order.id), "no longer polled");
  const [attempt] = (await db.listDeliveryAttempts()).filter((a) => a.order_id === order.id);
  assert.equal(attempt.status, "cancelled");
  assert.equal(attempt.call_status, "resolved");
});

test("a fresh courier cancellation alerts the owner but never the customer", async () => {
  const { order } = await seedBookedParcel("CANCEL-NEW", "0771112202");
  const cancelledAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const bookedAt = new Date(cancelledAt.getTime() - 14 * 24 * 60 * 60 * 1000);
  await replayPoll("CANCEL-NEW", autoCancelledHistory(courierTimestamp(bookedAt), courierTimestamp(cancelledAt)));

  assert.equal((await db.getOrder(order.id)).order_status, "cancelled");
  const jobs = await db.listOrderNotifications(order.id);
  assert.deepEqual(jobs.map((job) => [job.recipient, job.notification_type]), [["owner", "owner_courier_cancelled"]]);
  assert.match(jobs[0].body, /COURIER CANCELLED/);
  assert.match(jobs[0].body, /CANCEL-NEW/);
});

test("a fresh cancellation of a bank-transfer order tells the owner the money is held", async () => {
  const { order } = await seedBookedParcel("CANCEL-PAID", "0771112203", {
    payment_method: "bank_transfer",
    total_cod: 0,
  });
  const cancelledAt = new Date(Date.now() - 60 * 60 * 1000);
  await replayPoll("CANCEL-PAID", autoCancelledHistory(courierTimestamp(new Date(cancelledAt.getTime() - 14 * 864e5)), courierTimestamp(cancelledAt)));
  const [job] = await db.listOrderNotifications(order.id);
  assert.equal(job.recipient, "owner");
  assert.match(job.body, /PAID BY BANK TRANSFER: Rs\. 1,340/);
  assert.doesNotMatch(job.body, /COD value/);
});
