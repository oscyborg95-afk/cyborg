import assert from "node:assert/strict";
import test from "node:test";
import {
  collectedAmountFromRemark,
  estimatePayout,
  learnDeliveryCharges,
  nextInvoicePeriodEnd,
  ratesFromInvoice,
} from "../lib/payout-estimate.ts";

const parcel = (overrides = {}) => ({
  order_id: "o1",
  total_cod: 1340,
  city: "Colombo 07",
  district: "Colombo",
  delivered_at: "2026-11-17T08:00:00.000Z",
  delivered_status: "Delivered",
  delivered_remarks: "",
  ...overrides,
});

// Mirrors the real Trans Express history: 475 almost everywhere, 525 in the east.
const history = [
  { city: "Colombo 07", district: "Colombo", delivery_charge: 475, count: 40 },
  { city: "Trincomalee", district: "Trincomalee", delivery_charge: 525, count: 3 },
  { city: "Ampara", district: "Ampara", delivery_charge: 525, count: 3 },
  { city: "Warakapola", district: "Kegalle", delivery_charge: 475, count: 4 },
  { city: "Warakapola", district: "Kegalle", delivery_charge: 725, count: 2 },
];

const latestInvoice = { collected_cod: 157401, commission: 1574.01, invoice_vat: 0, delivery_charges: 60750 };

test("matches the courier's own arithmetic: COD minus delivery minus 1% commission", () => {
  const estimate = estimatePayout({
    parcels: [parcel()],
    charge_history: history,
    latest_invoice: latestInvoice,
    last_paid_at: "2026-11-11T18:30:00.000Z",
    settings_base_charge: 350,
    district_overrides: {},
    now: new Date("2026-11-19T06:00:00.000Z"),
  });
  // 1340 - 475 - 13.40, exactly what invoice TRA-26-11-655641 paid per such parcel.
  assert.equal(estimate.total.net, 851.6);
  assert.equal(estimate.commission_rate, 0.01);
  assert.equal(estimate.vat_rate, 0);
  // The learned 475 replaces a stale settings value of 350.
  assert.equal(estimate.base_charge, 475);
});

test("prepaid parcels still cost the delivery charge", () => {
  const estimate = estimatePayout({
    parcels: [parcel({ total_cod: 0 })],
    charge_history: history,
    latest_invoice: latestInvoice,
    last_paid_at: null,
    settings_base_charge: 475,
    district_overrides: {},
    now: new Date("2026-11-19T06:00:00.000Z"),
  });
  assert.equal(estimate.prepaid_count, 1);
  assert.equal(estimate.total.net, -475);
});

test("delivery charges come from the city, then the owner's override, then the district", () => {
  const model = learnDeliveryCharges(history, 350, { Ampara: 600 });
  assert.equal(model.chargeFor("Trincomalee", "Trincomalee"), 525);
  assert.equal(model.chargeFor("  trincomalee ", ""), 525, "city names are matched loosely");
  // A city's own history beats the owner's district override.
  assert.equal(model.chargeFor("Ampara", "Ampara"), 525);
  assert.equal(model.chargeFor("Uhana", "Ampara"), 600);
  // Warakapola's two heavy parcels do not outvote its four normal ones.
  assert.equal(model.chargeFor("Warakapola", "Kegalle"), 475);
  assert.equal(model.chargeFor("Somewhere new", "Unknown"), 475);
  assert.equal(model.learnedFromLines, 52);
});

test("with no invoice history the settings charge and a 1% commission are used", () => {
  assert.equal(learnDeliveryCharges([], 400).chargeFor("Kandy", "Kandy"), 400);
  assert.deepEqual(ratesFromInvoice(null), { commission_rate: 0.01, vat_rate: 0 });
  assert.deepEqual(
    ratesFromInvoice({ collected_cod: 10000, commission: 200, invoice_vat: 135, delivery_charges: 475 }),
    { commission_rate: 0.02, vat_rate: 0.2 }
  );
});

test("partial deliveries use the amount the courier says it collected", () => {
  assert.equal(collectedAmountFromRemark("Collected COD Rs. 1.00.  Requested by online store"), 1);
  assert.equal(collectedAmountFromRemark("Collected COD Rs. 1,240.00."), 1240);
  assert.equal(collectedAmountFromRemark("Customer took one item"), null);

  const estimate = estimatePayout({
    parcels: [
      parcel({ order_id: "known", delivered_status: "Partially Delivered", delivered_remarks: "Collected COD Rs. 1.00. Requested by online store" }),
      parcel({ order_id: "unknown", delivered_status: "Partially Delivered", delivered_remarks: "" }),
    ],
    charge_history: history,
    latest_invoice: latestInvoice,
    last_paid_at: null,
    settings_base_charge: 475,
    district_overrides: {},
    now: new Date("2026-11-19T06:00:00.000Z"),
  });
  assert.deepEqual(estimate.partial.map((p) => [p.order_id, p.collected_cod, p.amount_known]), [
    ["known", 1, true],
    ["unknown", 0, false],
  ]);
  // Rs 1 collected - 475 - 0.01 commission, then 0 - 475.
  assert.equal(estimate.total.net, -949.01);
  assert.equal(estimate.total.gross_cod, 2680);
});

test("the next invoice closes on the first Thursday after the last settlement", () => {
  // Recorded Thursday 12 Nov (midnight Colombo) → covers up to Thursday 19 Nov.
  const fromThursday = nextInvoicePeriodEnd("2026-11-11T18:30:00.000Z", new Date("2026-11-19T06:00:00.000Z"));
  assert.equal(fromThursday.periodEnd, "2026-11-19");
  assert.equal(fromThursday.endsAt.toISOString(), "2026-11-19T18:30:00.000Z"); // Fri 00:00 Colombo
  // Recorded on the Friday instead → still the same next Thursday.
  assert.equal(nextInvoicePeriodEnd("2026-11-13T05:00:00.000Z", new Date()).periodEnd, "2026-11-19");
  // No history: the coming Thursday, or today when it is Thursday.
  assert.equal(nextInvoicePeriodEnd(null, new Date("2026-11-17T06:00:00.000Z")).periodEnd, "2026-11-19");
  assert.equal(nextInvoicePeriodEnd(null, new Date("2026-11-19T17:00:00.000Z")).periodEnd, "2026-11-19");
});

test("parcels delivered after the Thursday cutoff roll to the following invoice", () => {
  const estimate = estimatePayout({
    parcels: [
      parcel({ order_id: "thu-night", delivered_at: "2026-11-19T16:00:00.000Z" }), // Thu 21:30 Colombo
      parcel({ order_id: "fri-morning", delivered_at: "2026-11-20T03:00:00.000Z" }), // Fri 08:30 Colombo
      parcel({ order_id: "no-timestamp", delivered_at: null }),
    ],
    charge_history: history,
    latest_invoice: latestInvoice,
    last_paid_at: "2026-11-11T18:30:00.000Z",
    settings_base_charge: 475,
    district_overrides: {},
    now: new Date("2026-11-20T04:00:00.000Z"),
  });
  assert.equal(estimate.next.count, 2);
  assert.equal(estimate.later.count, 1);
  assert.equal(estimate.next.period_end, "2026-11-19");
  assert.equal(estimate.next.overdue, true);
  assert.equal(estimate.total.net, estimate.next.net + estimate.later.net);
});
