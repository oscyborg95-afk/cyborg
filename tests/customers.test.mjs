import assert from "node:assert/strict";
import test from "node:test";
import { groupOrdersByCustomerIdentity, orderIdentityKeys } from "../lib/customer-identity.ts";

const order = (id, primary, secondary = "") => ({
  id,
  phone_number: primary,
  phone_2: secondary,
  created_at: "2026-01-01T00:00:00.000Z",
});

test("Sri Lankan local and international phone formats produce one identity", () => {
  assert.deepEqual(orderIdentityKeys(order("1", "077 123 4567", "+94 77 123 4567")), ["771234567"]);
});

test("secondary numbers link complete customer order history", () => {
  const groups = groupOrdersByCustomerIdentity([
    order("1", "0771234567", "0719876543"),
    order("2", "+94 71 987 6543"),
  ]);
  assert.equal(groups.size, 1);
  assert.deepEqual([...groups.values()][0].map((row) => row.id), ["1", "2"]);
});
