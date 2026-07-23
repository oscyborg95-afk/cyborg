import assert from "node:assert/strict";
import test from "node:test";
import { insideQuietHours, needsAgentHandoff } from "../lib/agent-policy.ts";

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
