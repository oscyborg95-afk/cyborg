import assert from "node:assert/strict";
import test from "node:test";
import { attentionCategory, occurrenceKey, sortAttentionItems } from "../lib/attention-logic.ts";

test("a genuinely new occurrence gets a distinct action key", () => {
  assert.notEqual(
    occurrenceKey("unreplied", "771234567", 100),
    occurrenceKey("unreplied", "771234567", 200)
  );
});

test("action queue sorts by priority then earliest due time", () => {
  const sorted = sortAttentionItems([
    { priority: "medium", due_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
    { priority: "high", due_at: "2026-01-02T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
    { priority: "high", due_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z" },
  ]);
  assert.deepEqual(sorted.map((item) => item.due_at), [
    "2026-01-01T00:00:00Z",
    "2026-01-02T00:00:00Z",
    "2026-01-01T00:00:00Z",
  ]);
  assert.equal(attentionCategory("failed_message"), "system");
});
