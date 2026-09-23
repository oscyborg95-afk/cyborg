import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import {
  buildDeliveryReport,
  buildOrdersReport,
  reportDay,
  reportToCsv,
  validReportDate,
} from "../lib/report-export.ts";
import { reportToPdf } from "../lib/report-pdf.ts";

const accounts = [
  { id: "mine", name: "Mine" },
  { id: "sister", name: "Sister" },
];
const orders = [
  {
    id: "one", sales_account_id: "mine", order_no: "AC-1",
    customer_name: "නිමාලි", phone_number: "0771234567", parsed_address: "Colombo",
    city: "Colombo", district: "Colombo", item_name: "Face Wash", items: null,
    product_price: 2000, shipping_fee: 300, discount: 0, total_cod: 2300,
    order_status: "delivered", created_at: "2026-09-22T20:00:00.000Z",
    archived_at: "2026-09-24T00:00:00.000Z",
  },
  {
    id: "two", sales_account_id: "sister", order_no: "AC-2",
    customer_name: "=HYPERLINK(\"bad\")", phone_number: "0779999999",
    parsed_address: "Kandy", city: "Kandy", district: "Kandy", item_name: "Serum",
    items: null, product_price: 1500, shipping_fee: 300, discount: 0,
    total_cod: 1800, order_status: "booked", created_at: "2026-09-24T08:00:00.000Z",
  },
];
const manifests = [
  { order_id: "one", tracking_id: "TRK-1", courier_name: "Courier A" },
  { order_id: "two", tracking_id: "TRK-2", courier_name: "Courier B" },
];
const attempts = [
  {
    id: "attempt-one", order_id: "one", tracking_id: "TRK-1", attempt_no: 2,
    status: "delivered", reason: "", last_event_at: "2026-09-25T10:00:00.000Z",
    next_delivery_date: null, call_status: "resolved", called_at: null, call_notes: "",
  },
  {
    id: "attempt-two", order_id: "two", tracking_id: "TRK-2", attempt_no: 1,
    status: "failed_to_deliver", reason: "No answer", last_event_at: "2026-09-24T09:00:00.000Z",
    next_delivery_date: "2026-09-26", call_status: "called_no_answer",
    called_at: "2026-09-24T10:00:00.000Z", call_notes: "Try later",
  },
];

test("report dates use Sri Lanka time and reject impossible days", () => {
  assert.equal(reportDay("2026-09-22T20:00:00.000Z"), "2026-09-23");
  assert.equal(validReportDate("2026-09-23"), true);
  assert.equal(validReportDate("2026-02-30"), false);
});

test("orders report includes archived history and separates sellers", () => {
  const all = buildOrdersReport(orders, manifests, accounts, { seller: "all", from: "", to: "" });
  assert.equal(all.rows.length, 2);
  const mine = buildOrdersReport(orders, manifests, accounts, {
    seller: "mine", from: "2026-09-23", to: "2026-09-23",
  });
  assert.equal(mine.rows.length, 1);
  assert.equal(mine.rows[0].cells[1], "AC-1");
  assert.equal(mine.rows[0].cells[2], "Mine");
  assert.equal(mine.rows[0].cells[16], "TRK-1");
});

test("delivery report filters by courier event date rather than order date", () => {
  const report = buildDeliveryReport(attempts, orders, manifests, accounts, {
    seller: "mine", from: "2026-09-25", to: "2026-09-25",
  });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].cells[1], "AC-1");
  assert.equal(report.rows[0].cells[7], "2");
});

test("CSV escapes spreadsheet formulas and quotes", () => {
  const report = buildOrdersReport(orders, manifests, accounts, { seller: "all", from: "", to: "" });
  const csv = reportToCsv(report);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.equal(csv.split("\r\n").length, 3);
});

test("PDF export creates a readable multi-page document", async () => {
  const report = buildOrdersReport(orders, manifests, accounts, { seller: "all", from: "", to: "" });
  report.rows = Array.from({ length: 15 }, (_, index) => ({
    ...report.rows[index % report.rows.length],
    heading: `AC-${index + 1} | නිමාලි`,
  }));
  const bytes = await reportToPdf(report);
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 2);
  assert.equal(pdf.getTitle(), "Orders report");
});
