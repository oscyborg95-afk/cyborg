import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCourierStatus,
  isTerminalCourierReturn,
  isTemporaryCourierReturn,
} from "../lib/courier-status.ts";

test("a branch reschedule is still in transit, not returned", () => {
  const status =
    "Returned to Branch Rescheduled — Order returned to branch for rescheduling";

  assert.equal(isTemporaryCourierReturn(status), true);
  assert.equal(classifyCourierStatus(status), "in_transit");
});

test("delivery reschedules are checked before the delivered keyword", () => {
  assert.equal(classifyCourierStatus("Delivery Rescheduled"), "in_transit");
  assert.equal(classifyCourierStatus("Out for Delivery"), "in_transit");
  assert.equal(classifyCourierStatus("Delivered"), "delivered");
  assert.equal(classifyCourierStatus("Returned to Client"), "returned");
});

test("P&L only counts a terminal return that remains the order outcome", () => {
  assert.equal(
    isTerminalCourierReturn("returned", "Returned to Branch Rescheduled"),
    false
  );
  assert.equal(
    isTerminalCourierReturn("delivered", "Return to HO (Invalid Destination)"),
    false
  );
  assert.equal(isTerminalCourierReturn("returned", "Returned to Client"), true);
});
