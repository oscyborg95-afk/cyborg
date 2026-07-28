import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRemittances } from "../lib/remittance-summary.ts";

const batch = (overrides = {}) => ({
  id: "r1",
  invoice_no: "INV-1",
  paid_at: "2026-07-05T03:00:00.000Z",
  source_filename: "invoice.xlsx",
  line_count: 2,
  matched_count: 2,
  gross_cod: 10000,
  collected_cod: 10000,
  delivery_charges: 500,
  commission: 250,
  invoice_vat: 90,
  additional_tax: 10,
  other_deductions: 50,
  invoice_payable: 9160,
  expected_net: 9100,
  amount_received: 9050,
  variance: -50,
  cash_applied: true,
  notes: "",
  created_at: "2026-07-05T03:00:00.000Z",
  ...overrides,
});

test("remittance summary treats actual receipt as paid-to-me cash", () => {
  const summary = summarizeRemittances(
    [
      batch(),
      batch({
        id: "r2",
        invoice_no: "INV-2",
        paid_at: "2026-06-30T18:00:00.000Z",
        amount_received: 2000,
        gross_cod: 2500,
      }),
    ],
    new Date("2026-07-20T00:00:00.000Z")
  );
  assert.equal(summary.total_paid_to_me, 11050);
  assert.equal(summary.paid_this_month, 9050);
  assert.equal(summary.courier_costs_and_deductions, 1800);
  assert.equal(summary.last_payout?.invoice_no, "INV-1");
});
