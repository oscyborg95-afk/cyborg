import assert from "node:assert/strict";
import test from "node:test";
import {
  filterInvoiceToOwnedWaybills,
  parseCourierInvoiceRows,
} from "../lib/remittance-invoice.ts";

test("courier invoice reconciles hidden percentage commission into net payable", () => {
  const headers = [
    "ORDER DATE", "WAYBILL ID", "INVOICE NO", "ORDER NO", "VAT %", "COMMISSION",
    "COD", "COLLECTED COD", "TOTAL VAT", "TOTAL COMMISSION", "DELIVERY CHARGE",
    "PAYABLE", "WEIGHT (KG)", "STATUS",
  ];
  const parsed = parseCourierInvoiceRows([
    headers,
    ["2026-07-08", "BE234457", "TRA-26-07-594215", "order-1", 0, 1, 1340, 1340, 0, 0, 475, 851.6, 1, "Delivered"],
    ["2026-07-07", "BE219730", "TRA-26-07-594215", "order-2", 0, 1, 2750, 2750, 0, 0, 475, 2247.5, 1, "Delivered"],
  ]);
  assert.equal(parsed.gross_cod, 4090);
  assert.equal(parsed.delivery_charges, 950);
  assert.equal(parsed.commission, 40.9);
  assert.equal(parsed.vat, 0);
  assert.equal(parsed.payable, 3099.1);
  assert.equal(parsed.collected_cod - parsed.delivery_charges - parsed.commission - parsed.vat, parsed.payable);
});

test("mixed courier invoice totals include only owned waybills", () => {
  const source = parseCourierInvoiceRows([
    ["ORDER DATE", "WAYBILL ID", "INVOICE NO", "ORDER NO", "VAT %", "COMMISSION", "COD", "COLLECTED COD", "TOTAL VAT", "TOTAL COMMISSION", "DELIVERY CHARGE", "PAYABLE", "WEIGHT (KG)", "STATUS"],
    ["2026-07-08", "MINE-1", "MIXED-1", "mine", 0, 1, 1340, 1340, 0, 0, 475, 851.6, 1, "Delivered"],
    ["2026-07-08", "OTHER-1", "MIXED-1", "other", 0, 1, 2750, 2750, 0, 0, 475, 2247.5, 1, "Delivered"],
  ]);
  const filtered = filterInvoiceToOwnedWaybills(source, [
    { waybill_id: "MINE-1", order_id: "order-1", order_status: "booked", remitted_at: null },
  ]);
  assert.equal(filtered.source_line_count, 2);
  assert.equal(filtered.matched_count, 1);
  assert.equal(filtered.ignored.length, 1);
  assert.equal(filtered.invoice.gross_cod, 1340);
  assert.equal(filtered.invoice.delivery_charges, 475);
  assert.equal(filtered.invoice.commission, 13.4);
  assert.equal(filtered.invoice.payable, 851.6);
  assert.equal(filtered.lines[0].matched_order_id, "order-1");
});

test("recorded settlement keeps actual receipt separate from invoice payable", async () => {
  delete process.env.DATABASE_URL;
  const db = await import("../lib/db.ts");
  const invoice = parseCourierInvoiceRows([
    ["ORDER DATE", "WAYBILL ID", "INVOICE NO", "ORDER NO", "VAT %", "COMMISSION", "COD", "COLLECTED COD", "TOTAL VAT", "TOTAL COMMISSION", "DELIVERY CHARGE", "PAYABLE", "WEIGHT (KG)", "STATUS"],
    ["2026-07-08", "BE234457", "TEST-INVOICE-1", "legacy-1", 0, 1, 1340, 1340, 0, 0, 475, 851.6, 1, "Delivered"],
  ]);
  const batch = await db.createCourierRemittance({
    invoice,
    lines: invoice.lines.map((line) => ({ ...line, matched_order_id: null })),
    paid_at: "2026-07-10T00:00:00.000Z",
    source_filename: "InvoiceDetails.xlsx",
    source_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    source_file: Buffer.from("test workbook"),
    additional_tax: 100,
    other_deductions: 0,
    amount_received: 6800,
    cash_applied: false,
    notes: "Already included in manually entered bank balance",
  });
  assert.equal(batch.invoice_payable, 851.6);
  assert.equal(batch.expected_net, 751.6);
  assert.equal(batch.amount_received, 6800);
  assert.equal(batch.variance, 6048.4);
  assert.equal(batch.cash_applied, false);
  assert.equal((await db.listCourierRemittances())[0].invoice_no, "TEST-INVOICE-1");
  assert.equal((await db.getCourierRemittanceFile(batch.id))?.data.toString(), "test workbook");
});
