import { NextRequest, NextResponse } from "next/server";
import {
  bookOrderOnce,
  OrderBookingConflictError,
} from "@/lib/db";
import { bookCourierOrder } from "@/lib/couriers";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const result = await bookOrderOnce(id, (order) =>
      bookCourierOrder(order, order.city_id)
    );
    return NextResponse.json({ manifest: result.manifest, reused: result.reused });
  } catch (err) {
    if (err instanceof OrderBookingConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : "Booking failed";
    return NextResponse.json(
      { error: message },
      { status: message === "Order not found" ? 404 : 502 }
    );
  }
}
