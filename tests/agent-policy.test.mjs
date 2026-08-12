import assert from "node:assert/strict";
import test from "node:test";
import {
  canAutoSendDecision,
  insideQuietHours,
  needsAgentHandoff,
  shouldPauseCustomer,
} from "../lib/agent-policy.ts";

test("quiet hours support an overnight Colombo window", () => {
  const config = { quiet_hours_start: "22:00", quiet_hours_end: "07:00" };
  // These UTC instants are 23:30 and 12:30 in Asia/Colombo.
  assert.equal(insideQuietHours(config, new Date("2026-07-22T18:00:00Z")), true);
  assert.equal(insideQuietHours(config, new Date("2026-07-22T07:00:00Z")), false);
});

test("equal quiet-hour boundaries disable the window", () => {
  assert.equal(
    insideQuietHours(
      { quiet_hours_start: "00:00", quiet_hours_end: "00:00" },
      new Date("2026-07-22T18:00:00Z")
    ),
    false
  );
});

test("handoff policy gates low-confidence autonomous replies", () => {
  assert.equal(needsAgentHandoff("reply", 0.91, 0.78), false);
  assert.equal(needsAgentHandoff("reply", 0.62, 0.78), true);
  assert.equal(needsAgentHandoff("handoff", 0.99, 0.78), true);
});

test("only genuine support or safety escalations pause the customer", () => {
  assert.equal(
    shouldPauseCustomer({
      action: "reply",
      intent: "other",
      handoff_reason: "Confidence is too low",
    }),
    false
  );
  assert.equal(
    shouldPauseCustomer({
      action: "handoff",
      intent: "other",
      handoff_reason: "The product detail is unclear",
    }),
    false
  );
  assert.equal(
    shouldPauseCustomer({
      action: "handoff",
      intent: "complaint",
      handoff_reason: "Customer is unhappy",
    }),
    true
  );
  assert.equal(
    shouldPauseCustomer({
      action: "handoff",
      intent: "other",
      handoff_reason: "Customer asked to speak to a human agent",
    }),
    true
  );
});

test("the agent carries ordinary sales turns on its own", () => {
  assert.equal(
    canAutoSendDecision({
      intent: "price_question",
      sales_stage: "consideration",
      language_confidence: 0.96,
    }),
    true
  );
  // Address collection and objection handling are part of the job now.
  assert.equal(
    canAutoSendDecision({
      intent: "address",
      sales_stage: "checkout_details",
      language_confidence: 0.95,
    }),
    true
  );
  assert.equal(
    canAutoSendDecision({
      intent: "order",
      sales_stage: "objection",
      language_confidence: 0.88,
    }),
    true
  );
});

test("autonomy stops where a wrong reply costs money or goodwill", () => {
  assert.equal(
    canAutoSendDecision({
      intent: "complaint",
      sales_stage: "consideration",
      language_confidence: 0.99,
    }),
    false
  );
  assert.equal(
    canAutoSendDecision({
      intent: "tracking",
      sales_stage: "support",
      language_confidence: 0.99,
    }),
    false
  );
  // Checkout keeps the stricter language bar: a misread address becomes a
  // failed COD delivery, not just an awkward message.
  assert.equal(
    canAutoSendDecision({
      intent: "confirmation",
      sales_stage: "checkout_confirmation",
      language_confidence: 0.85,
    }),
    false
  );
  assert.equal(
    canAutoSendDecision({
      intent: "availability",
      sales_stage: "consideration",
      language_confidence: 0.72,
    }),
    false
  );
});
