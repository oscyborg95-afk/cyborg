import { NextRequest, NextResponse } from "next/server";
import { markInvoicesPrinted } from "@/lib/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mark a batch of invoices as printed (after the operator confirms the sheets
// came out), or undo that for a reprint. Body: { ids: string[], printed: boolean }.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { ids?: unknown; printed?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string" && UUID.test(id)) : [];
  if (ids.length === 0 || ids.length > 1000) {
    return NextResponse.json({ error: "Send between 1 and 1000 order ids" }, { status: 400 });
  }
  const printed = body.printed !== false;
  try {
    const updated = await markInvoicesPrinted([...new Set(ids)], printed);
    return NextResponse.json({ ok: true, updated });
  } catch (err) {
    console.error("Marking invoices printed failed", err);
    return NextResponse.json({ error: "Could not save the print status. Please try again." }, { status: 500 });
  }
}
