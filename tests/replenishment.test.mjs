import test from "node:test";
import assert from "node:assert/strict";
import {
  addCivilDays,
  analyzeReplenishment,
  automaticSendEligibility,
  demandPace,
  normalizeDemand,
  renderPurchaseMessage,
  roundToPack,
  workingDayArrival,
} from "../lib/replenishment.ts";
import { createProduct } from "../lib/db.ts";
import {
  createPurchaseOrder,
  receivePurchaseOrder,
  saveProductConfig,
  saveSupplier,
} from "../lib/replenishment-db.ts";

const now = new Date("2026-09-08T03:00:00.000Z");

test("working-day arrival skips Sunday and packaged/custom closure dates", () => {
  const result = workingDayArrival({
    startDate: "2026-04-10", // Friday
    leadTimeWorkingDays: 1,
    workingWeekdays: [1, 2, 3, 4, 5, 6],
    closures: [
      { date: "2026-04-11", name: "Courier shutdown", source: "custom" },
      { date: "2026-04-13", name: "Public holiday", source: "holiday" },
    ],
  });
  assert.equal(result.arrivalDate, "2026-04-14");
  assert.deepEqual(result.skipped.map((x) => x.date), ["2026-04-11", "2026-04-12", "2026-04-13"]);
});

test("calendar arithmetic remains civil and deterministic", () => {
  assert.equal(addCivilDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addCivilDays("2026-03-01", -1), "2026-02-28");
});

test("demand calculation retains zero days and reacts to recent acceleration", () => {
  const today = "2026-09-08";
  const demand = Array.from({ length: 14 }, (_, index) => ({ date: addCivilDays(today, index - 13), units: index < 7 ? 1 : 4 }));
  const series = normalizeDemand(demand, today, 28);
  const pace = demandPace(series);
  assert.equal(series.length, 28);
  assert.ok(pace.recent > pace.baseline);
  assert.ok(pace.adjusted > pace.baseline);
  assert.ok(pace.variability > 0);
});

test("one extreme day is capped instead of producing an absurd rate", () => {
  const series = Array.from({ length: 28 }, (_, index) => ({ date: `d${index}`, units: index === 27 ? 1000 : 1 }));
  const pace = demandPace(series);
  assert.ok(pace.adjusted < 3);
});

test("MOQ and supplier packs round conservatively", () => {
  assert.equal(roundToPack(0, 12, 24), 0);
  assert.equal(roundToPack(7, 6, 24), 24);
  assert.equal(roundToPack(25, 6, 24), 30);
});

test("analysis uses inventory position and keeps a partially covered shortage actionable", () => {
  const daily = Array.from({ length: 28 }, (_, index) => ({ date: addCivilDays("2026-09-08", index - 27), units: index % 3 === 0 ? 4 : 2 }));
  const base = analyzeReplenishment({ productId: "p", productName: "Tea", currentStock: 4, unitCost: 200, demand: daily, now, supplierConfigured: true, leadTimeWorkingDays: 1, workingWeekdays: [1,2,3,4,5,6], targetCoverDays: 14, packSize: 6, moq: 12 });
  const partialInbound = analyzeReplenishment({ productId: "p", productName: "Tea", currentStock: 4, unitCost: 200, demand: daily, now, supplierConfigured: true, supplierId: "s", leadTimeWorkingDays: 1, workingWeekdays: [1,2,3,4,5,6], targetCoverDays: 14, packSize: 6, moq: 12, openInboundUnits: 24 });
  const adequateInbound = analyzeReplenishment({ productId: "p", productName: "Tea", currentStock: 4, unitCost: 200, demand: daily, now, supplierConfigured: true, supplierId: "s", leadTimeWorkingDays: 1, workingWeekdays: [1,2,3,4,5,6], targetCoverDays: 14, packSize: 6, moq: 12, openInboundUnits: 500 });
  assert.equal(base.exposureDays, 2);
  assert.ok(base.safetyStock > 0);
  assert.equal(base.recommendedQuantity % 6, 0);
  assert.ok(partialInbound.recommendedQuantity > 0);
  assert.ok(partialInbound.recommendedQuantity < base.recommendedQuantity);
  assert.equal(partialInbound.status, "order_now");
  assert.equal(adequateInbound.recommendedQuantity, 0);
  assert.equal(adequateInbound.status, "already_ordered");
});

test("automatic sending requires an actionable recommendation with medium/high confidence", () => {
  const highConfidence = analyzeReplenishment({ productId: "p", productName: "Tea", currentStock: 0, unitCost: 200, demand: Array.from({ length: 28 }, (_, index) => ({ date: addCivilDays("2026-09-08", index - 27), units: 2 })), now, supplierConfigured: true, supplierId: "supplier" });
  const lowConfidence = analyzeReplenishment({ productId: "p", productName: "Tea", currentStock: 0, unitCost: 200, demand: [{ date: "2026-09-08", units: 2 }], now, supplierConfigured: true, supplierId: "supplier" });
  assert.equal(automaticSendEligibility(highConfidence).eligible, true);
  assert.equal(automaticSendEligibility(lowConfidence).eligible, false);
  assert.match(automaticSendEligibility(lowConfidence).reasons.join(" "), /confidence/i);
});

test("sparse and absent demand are labelled honestly", () => {
  const absent = analyzeReplenishment({ productId: "p", productName: "Tea", currentStock: 4, unitCost: 200, demand: [], now, supplierConfigured: true });
  const sparse = analyzeReplenishment({ productId: "p", productName: "Tea", currentStock: 4, unitCost: 200, demand: [{ date: "2026-09-08", units: 2 }], now, supplierConfigured: true });
  assert.equal(absent.status, "no_demand_data");
  assert.equal(absent.confidence, "none");
  assert.equal(sparse.confidence, "low");
});

test("message renderer includes reference, business, items, date, and confirmation request", () => {
  const text = renderPurchaseMessage({ supplierName: "Nimal", businessName: "Daily Cart", reference: "PO-1001", expectedDeliveryDate: "2026-09-10", lines: [{ name: "Herbal Tea", quantity: 24, supplierSku: "HT24" }] });
  for (const fragment of ["Nimal", "Daily Cart", "PO-1001", "Herbal Tea", "24 units", "2026-09-10", "confirm"]) assert.match(text, new RegExp(fragment, "i"));
});

test("recommendation cycle and stock receipt are idempotent in fallback mode", async () => {
  const product = await createProduct({ name: `Test stock ${Date.now()}`, price: 500, unit_cost: 100, stock_units: 5 });
  const supplier = await saveSupplier({ name: `Test supplier ${Date.now()}`, whatsapp_phone: "0771234567", lead_time_working_days: 1, working_weekdays: [1,2,3,4,5,6], active: true, automatic_send: false });
  await saveProductConfig({ product_id: product.id, supplier_id: supplier.id, moq: 1, pack_size: 1, supplier_sku: "", unit_cost: 120, preferred: true, target_cover_days: 14 });
  const first = await createPurchaseOrder({ supplierId: supplier.id, lines: [{ productId: product.id, quantity: 10 }], now });
  const duplicate = await createPurchaseOrder({ supplierId: supplier.id, lines: [{ productId: product.id, quantity: 10 }], now });
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.order.id, first.order.id);
  const line = first.order.lines[0];
  const once = await receivePurchaseOrder(first.order.id, [{ lineId: line.id, quantity: 10, unitCost: 120 }], "receipt-test-001");
  const twice = await receivePurchaseOrder(first.order.id, [{ lineId: line.id, quantity: 10, unitCost: 120 }], "receipt-test-001");
  assert.equal(once.lines[0].received_quantity, 10);
  assert.equal(twice.lines[0].received_quantity, 10);
  assert.equal(twice.status, "received");
  const nextCycleRevision = await createPurchaseOrder({ supplierId: supplier.id, lines: [{ productId: product.id, quantity: 4 }], now });
  assert.equal(nextCycleRevision.reused, false);
  assert.notEqual(nextCycleRevision.order.id, first.order.id);
  assert.match(nextCycleRevision.order.dedupe_key, /:r2$/);
});
