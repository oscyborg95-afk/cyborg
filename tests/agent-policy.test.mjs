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

test("autonomy starts with high-confidence low-risk sales intents", () => {
  assert.equal(
    canAutoSendDecision({
      intent: "price_question",
      sales_stage: "consideration",
      language_confidence: 0.96,
    }),
    true
  );
  assert.equal(
    canAutoSendDecision({
      intent: "order",
      sales_stage: "checkout_details",
      language_confidence: 0.98,
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
