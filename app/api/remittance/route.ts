import { NextRequest, NextResponse } from "next/server";
import { readSheet } from "read-excel-file/node";
import {
  createCourierRemittance,
  findRemittanceMatches,
  listCourierRemittances,
} from "@/lib/db";
import { parseCourierInvoiceRows, type InvoiceCell } from "@/lib/remittance-invoice";

export const runtime = "nodejs";
const MAX_INVOICE_BYTES = 3 * 1024 * 1024;

const numericField = (form: FormData, name: string) => {
  const value = Number(form.get(name) ?? 0);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.round(value * 100) / 100;
};

async function readInvoice(form: FormData) {
  const file = form.get("invoice");
  if (!(file instanceof File)) throw new Error("Choose a courier .xlsx invoice");
  if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("Only .xlsx courier invoices are supported");
  if (file.size <= 0 || file.size > MAX_INVOICE_BYTES) throw new Error("Invoice must be between 1 byte and 3 MB");
  const bytes = Buffer.from(await file.arrayBuffer());
  const rows = (await readSheet(bytes)) as InvoiceCell[][];
  return { file, bytes, invoice: parseCourierInvoiceRows(rows) };
}

async function preview(form: FormData) {
  const parsed = await readInvoice(form);
  const matches = await findRemittanceMatches(
    parsed.invoice.lines.map((line) => line.order_no),
    parsed.invoice.lines.map((line) => line.waybill_id)
  );
  const byWaybill = new Map(matches.flatMap((match) => match.tracking_id ? [[match.tracking_id, match.order] as const] : []));
  const byReference = new Map(matches.flatMap((match) => [
    [match.order.id, match.order] as const,
    ...(match.order.order_no ? [[match.order.order_no, match.order] as const] : []),
  ]));
  let matchedCount = 0;
  let alreadyRemittedCount = 0;
  const unmatched: Array<{ waybill_id: string; order_no: string; reason: string }> = [];
  const lines = parsed.invoice.lines.map((line) => {
    const order = byWaybill.get(line.waybill_id) ?? byReference.get(line.order_no);
    const eligible = order?.order_status === "delivered" && !order.remitted_at;
    if (eligible) matchedCount++;
    else if (order?.remitted_at) alreadyRemittedCount++;
    else unmatched.push({
      waybill_id: line.waybill_id,
      order_no: line.order_no,
      reason: order ? `Order is ${order.order_status}, not delivered` : "Not found in this system",
    });
    return { ...line, matched_order_id: eligible ? order.id : null };
  });
  return { ...parsed, lines, matched_count: matchedCount, already_remitted_count: alreadyRemittedCount, unmatched };
}

export async function GET() {
  try {
    return NextResponse.json({ remittances: await listCourierRemittances() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load courier payouts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const result = await preview(form);
    if (form.get("mode") !== "commit") {
      return NextResponse.json({
        invoice: result.invoice,
        matched_count: result.matched_count,
        already_remitted_count: result.already_remitted_count,
        unmatched: result.unmatched,
      });
    }

    const paidAtRaw = String(form.get("paid_at") ?? "");
    const paidAt = new Date(paidAtRaw);
    if (!paidAtRaw || Number.isNaN(paidAt.getTime())) throw new Error("paid_at must be a valid date and time");
    const additionalTax = numericField(form, "additional_tax");
    const otherDeductions = numericField(form, "other_deductions");
    const amountReceived = numericField(form, "amount_received");
    const cashApplied = String(form.get("cash_applied") ?? "true") === "true";
    const notes = String(form.get("notes") ?? "").trim().slice(0, 2000);
    const batch = await createCourierRemittance({
      invoice: result.invoice,
      lines: result.lines,
      paid_at: paidAt.toISOString(),
      source_filename: result.file.name.slice(0, 255),
      source_mime: result.file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      source_file: result.bytes,
      additional_tax: additionalTax,
      other_deductions: otherDeductions,
      amount_received: amountReceived,
      cash_applied: cashApplied,
      notes,
    });
    return NextResponse.json({ remittance: batch }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Courier invoice processing failed";
    const duplicate = (err as { code?: string }).code === "23505" || message.includes("already been recorded");
    return NextResponse.json({ error: duplicate ? "This invoice has already been recorded" : message }, { status: duplicate ? 409 : 400 });
  }
}
