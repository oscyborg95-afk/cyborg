import assert from "node:assert/strict";
import test from "node:test";
import {
  addTrackingEvent,
  listSettlementEvents,
  listTrackingEventsForOrders,
} from "../lib/db.ts";

// Both feeds replace a whole-table read that was capped at the 2000 OLDEST
// events, which silently hid every recent checkpoint once the table grew.
const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";

// Seeded once for the whole file: the in-memory store is shared.
{
  await addTrackingEvent(ORDER_A, "Picked up", "in_transit", null, "2026-01-02T00:00:00.000Z");
  await addTrackingEvent(ORDER_A, "Delivered", "delivered", null, "2026-01-05T00:00:00.000Z");
  await addTrackingEvent(ORDER_B, "Out for delivery", "in_transit", null, "2026-01-03T00:00:00.000Z");
  await addTrackingEvent(ORDER_B, "Returned to sender", "returned", null, "2026-01-01T00:00:00.000Z");
}

test("settlement feed carries only delivered/returned events, oldest first", async () => {
  const events = (await listSettlementEvents()).filter(
    (e) => e.order_id === ORDER_A || e.order_id === ORDER_B
  );
  assert.deepEqual(
    events.map((e) => [e.order_id, e.outcome]),
    [
      [ORDER_B, "returned"],
      [ORDER_A, "delivered"],
    ]
  );
});

test("the timeline feed is scoped to the orders asked for", async () => {
  const events = await listTrackingEventsForOrders([ORDER_B]);
  assert.deepEqual(
    events.map((e) => e.checkpoint),
    ["Returned to sender", "Out for delivery"]
  );
  assert.deepEqual(await listTrackingEventsForOrders([]), []);
});
