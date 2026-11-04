import { NextRequest, NextResponse } from "next/server";
import { OrderCancelConflictError, cancelOrder } from "@/lib/db";

// Cancel a pending or booked order whose parcel has not left the shop. The
// stock goes back on the shelf and the order drops out of invoices, tracking
// and shipped metrics. The courier waybill itself is cancelled by the operator
// with the courier — this records it on our side.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
  const reason = typeof body.reason === "string" ? body.reason : "";
  try {
    const order = await cancelOrder(id, reason);
    return NextResponse.json({ ok: true, order });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Cancel failed";
    if (message === "Order not found") return NextResponse.json({ error: message }, { status: 404 });
    if (err instanceof OrderCancelConflictError) return NextResponse.json({ error: message }, { status: 409 });
    console.error("Order cancel failed", err);
    return NextResponse.json({ error: "The order could not be cancelled. Please try again." }, { status: 500 });
  }
}
