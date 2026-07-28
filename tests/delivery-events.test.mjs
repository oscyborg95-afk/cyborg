import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPublicTrackingHistory,
  normalizeCourierHistory,
  normalizeDeliveryStatus,
  ownerCallDueAt,
  parseRescheduleDate,
} from "../lib/delivery-events.ts";

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
