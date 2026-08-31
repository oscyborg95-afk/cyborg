import assert from "node:assert/strict";
import test from "node:test";
import {
  codToCollect,
  isPrepaid,
  orderRevenue,
  orderValue,
  owesRefund,
  paymentMethodOf,
} from "../lib/payments.ts";
import { computeMetrics } from "../lib/metrics.ts";
import { makeTemplates } from "../lib/templates.ts";

const order = (over = {}) => ({
  id: over.id ?? "o1",
  customer_name: "Nimal",
  phone_number: "0771234567",
  phone_2: "",
  raw_address: "",
  parsed_address: "1 Main St",
  city: "Kandy",
  city_id: null,
  district: "Kandy",
  product_id: null,
  item_name: "Cream",
  items: null,
  product_price: 2500,
  shipping_fee: 400,
  discount: 0,
  total_cod: 2900,
  order_status: "delivered",
  payment_method: "cod",
  replaces_order_id: null,
  created_at: "2026-08-10T04:00:00.000Z",
  ...over,
});

test("orders with no payment method recorded are treated as COD", () => {
  assert.equal(paymentMethodOf({}), "cod");
  assert.equal(paymentMethodOf({ payment_method: null }), "cod");
  assert.equal(paymentMethodOf({ payment_method: "nonsense" }), "cod");
  assert.equal(isPrepaid({ payment_method: null }), false);
});

test("prepaid parcels ship with nothing for the courier to collect", () => {
  assert.equal(codToCollect(2900, "cod"), 2900);
  assert.equal(codToCollect(2900, "bank_transfer"), 0);
  assert.equal(codToCollect(2900, "replacement"), 0);
});

test("a bank transfer earns full revenue even though the courier collects nothing", () => {
  const o = order({ payment_method: "bank_transfer", total_cod: 0 });

  assert.equal(orderValue(o), 2900);
  assert.equal(orderRevenue(o), 2900);
});

test("a replacement parcel earns nothing — that is the point of it", () => {
  const o = order({ payment_method: "replacement", total_cod: 0, replaces_order_id: "o0" });

  assert.equal(orderRevenue(o), 0);
});

test("a genuine discount still reduces revenue on a bank transfer", () => {
  const o = order({ payment_method: "bank_transfer", total_cod: 0, discount: 400 });

  assert.equal(orderRevenue(o), 2500);
});

test("existing COD revenue reads the stored total, so no history shifts", () => {
  // A legacy row whose stored total does not match its components must keep
  // reporting the number it has always reported.
  const o = order({ payment_method: null, total_cod: 3100 });

  assert.equal(orderRevenue(o), 3100);
});

test("a returned bank transfer owes a refund; a returned COD parcel does not", () => {
  assert.equal(
    owesRefund(order({ payment_method: "bank_transfer", total_cod: 0, order_status: "returned" })),
    true
  );
  assert.equal(owesRefund(order({ order_status: "returned" })), false);
  assert.equal(
    owesRefund(order({ payment_method: "bank_transfer", total_cod: 0, order_status: "delivered" })),
    false
  );
});

test("prepaid parcels get the already-paid message, never a Rs. 0 demand", () => {
  const t = makeTemplates({}, "Daily Cart");

  const prepaid = t.shippedConfirmation(0, "TRK-1", true);
  assert.doesNotMatch(prepaid, /0/);
  assert.match(prepaid, /TRK-1/);

  assert.match(t.shippedConfirmation(2900, "TRK-1", false), /2900/);
});

// --- The reason this field exists: the P&L ----------------------------------

const settings = {
  bank_cash: 0,
  stock_units: 0,
  stock_unit_cost: 1000,
  courier_cost_base: 350,
  courier_return_cost: 200,
  courier_cost_overrides: {},
};

function pnlFor(orders, events) {
  return computeMetrics(orders, [], settings, [], events, []).pnl.month;
}

test("a bank-transfer sale is revenue, not a loss disguised as a discount", () => {
  const day = new Date();
  const delivered = [
    { id: "e1", order_id: "o1", checkpoint: "Delivered", outcome: "delivered", created_at: day.toISOString() },
  ];

  const asCod = pnlFor([order({ id: "o1" })], delivered);
  const asTransfer = pnlFor(
    [order({ id: "o1", payment_method: "bank_transfer", total_cod: 0 })],
    delivered
  );

  // Same money in, so the same profit — the payment rail must not change it.
  assert.equal(asTransfer.revenue, asCod.revenue);
  assert.equal(asTransfer.netProfit, asCod.netProfit);
  assert.ok(asTransfer.netProfit > 0);
});

test("a replacement parcel books as a measurable loss, not a mystery", () => {
  const day = new Date();
  const metrics = computeMetrics(
    [order({ id: "o1", payment_method: "replacement", total_cod: 0, replaces_order_id: "o0" })],
    [],
    settings,
    [],
    [
      { id: "e1", order_id: "o1", checkpoint: "Delivered", outcome: "delivered", created_at: day.toISOString() },
    ],
    []
  );

  assert.equal(metrics.pnl.month.revenue, 0);
  assert.ok(metrics.pnl.month.netProfit < 0);
  assert.equal(metrics.mistakeCost.monthCount, 1);
  // COGS (fallback unit cost) + one courier leg.
  assert.equal(metrics.mistakeCost.monthLoss, 1000 + 350);
});

test("bank-transfer cash is surfaced separately — no courier will ever remit it", () => {
  const metrics = computeMetrics(
    [
      order({
        id: "o1",
        payment_method: "bank_transfer",
        total_cod: 0,
        order_status: "booked",
        created_at: new Date().toISOString(),
      }),
    ],
    [],
    settings,
    [],
    [],
    []
  );

  assert.equal(metrics.cashFlow.prepaidThisMonthCount, 1);
  assert.equal(metrics.cashFlow.prepaidThisMonth, 2900);
  // It is not riding with a courier, so it must not inflate the float.
  assert.equal(metrics.cashFlow.floating, 0);
});
