import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TEMPLATES, makeTemplates } from "../lib/templates.ts";

test("renders the default rescheduled-delivery message with its tracking number", () => {
  const text = makeTemplates().rescheduledDelivery("AT123456");

  assert.equal(text, DEFAULT_TEMPLATES.rescheduledDelivery.replace("{{tracking}}", "AT123456"));
});

test("renders a customized rescheduled-delivery message", () => {
  const text = makeTemplates({
    rescheduledDelivery: "Delivery date changed. New attempt coming soon.\nTrack: {{tracking}}",
  }).rescheduledDelivery("AT654321");

  assert.equal(text, "Delivery date changed. New attempt coming soon.\nTrack: AT654321");
});

test("customer-facing defaults use the tenant business name", () => {
  const branded = makeTemplates({}, "Lotus Home");
  assert.match(branded.shippedConfirmation(2500, "TRK-9"), /Lotus Home/);
  assert.doesNotMatch(branded.shippedConfirmation(2500, "TRK-9"), /Daily Cart/);
  assert.match(branded.deliveredThanks(), /Lotus Home/);
});
