import { NextRequest, NextResponse } from "next/server";
import { remitOrders } from "@/lib/db";

// Cash reconciliation: the courier hands over a COD payout batch → mark those
// delivered orders as remitted and move the total into bank cash, atomically.
export async function POST(req: NextRequest) {
  const body = await req.json();
  const ids = Array.isArray(body.order_ids)
    ? body.order_ids.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "order_ids is required" }, { status: 400 });
  }

  try {
    const { count, total } = await remitOrders(ids);
    return NextResponse.json({ count, total });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Remittance failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
