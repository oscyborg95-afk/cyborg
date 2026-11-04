import { NextRequest, NextResponse } from "next/server";
import { listCustomerAlerts, listTrackingEventsForOrders } from "@/lib/db";

// One order's full courier timeline and customer-alert history, loaded when
// the operator opens it instead of shipping every order's history up front.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid order id" }, { status: 400 });
  try {
    const [events, alerts] = await Promise.all([
      listTrackingEventsForOrders([id]),
      listCustomerAlerts([id]),
    ]);
    return NextResponse.json({ events, alerts });
  } catch (err) {
    console.error("Timeline load failed", err);
    return NextResponse.json({ error: "The timeline could not be loaded." }, { status: 500 });
  }
}
