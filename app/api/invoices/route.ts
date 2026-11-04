import { NextRequest, NextResponse } from "next/server";
import { listInvoiceBatch } from "@/lib/db";
import { DUP_WINDOW_HOURS } from "@/lib/risk";

// One invoice batch: the dispatched orders the printer shows, their tracking
// IDs, and the handful of neighbouring orders needed to flag duplicates. The
// printer used to load /api/orders — 200 orders plus every timeline, alert and
// delivery attempt — just to print one day.
//
// `from` / `to` are ISO instants (the browser sends its own local midnights, so
// "a day" matches the operator's calendar). Omit both for the latest batch.
export async function GET(req: NextRequest) {
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  const valid = (v: string | null) => v === null || !Number.isNaN(Date.parse(v));
  if (!valid(from) || !valid(to) || Boolean(from) !== Boolean(to)) {
    return NextResponse.json({ error: "from and to must both be ISO dates" }, { status: 400 });
  }
  if (from && to && from >= to) {
    return NextResponse.json({ error: "from must be before to" }, { status: 400 });
  }
  try {
    const batch = await listInvoiceBatch({ from, to, windowHours: DUP_WINDOW_HOURS });
    return NextResponse.json(batch);
  } catch (err) {
    console.error("Invoice batch load failed", err);
    return NextResponse.json(
      { error: "Invoices could not be loaded. Please try again." },
      { status: 500 }
    );
  }
}
