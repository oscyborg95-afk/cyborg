import assert from "node:assert/strict";
import test from "node:test";
import {
  customerWebhookMessage,
  inspectCourierWebhook,
  parseCourierWebhook,
  webhookCheckpoint,
} from "../lib/courier-webhook.ts";

test("parses nested TransExpress-style reschedule payloads", () => {
  const event = parseCourierWebhook({
    data: {
      waybill_id: "AT123456",
      status: "rescheduled",
      remarks: "Customer unavailable",
      delivery_attempts: 2,
    },
  });
  assert.deepEqual(event, {
    trackingId: "AT123456",
    status: "rescheduled",
    remarks: "Customer unavailable",
    attempt: 2,
  });
  assert.equal(
    webhookCheckpoint(event),
    "Rescheduled — attempt 2 — Customer unavailable"
  );
});

test("strict inspection reports payload shape and missing identity fields", () => {
  const inspected = inspectCourierWebhook({ data: { remarks: "No answer" } });
  assert.equal(inspected.event, null);
  assert.deepEqual(inspected.missing, ["waybill_id", "status"]);
  assert.deepEqual(inspected.observedKeys, ["data", "remarks"]);
});

test("accepts alternative waybill and mapped-status keys", () => {
  assert.equal(
    parseCourierWebhook({ tracking_number: "AT123456", mapped_status: "failed_to_deliver" })?.status,
    "failed_to_deliver"
  );
});

test("only a rescheduled event sends the rescheduled-delivery customer message", () => {
  const rescheduled = {
    trackingId: "AT123456",
    status: "rescheduled",
    remarks: "",
    attempt: 1,
  };
  const failed = { ...rescheduled, status: "failed_to_deliver" };

  assert.equal(customerWebhookMessage(rescheduled, "Delivery rescheduled"), "Delivery rescheduled");
  assert.equal(customerWebhookMessage(failed, "Delivery rescheduled"), null);
});
