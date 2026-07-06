import { NextRequest, NextResponse } from "next/server";
import { addTrackingEvent, createManifest, getOrder, updateOrderStatus } from "@/lib/db";
import { bookCourierOrder } from "@/lib/couriers";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const order = await getOrder(id);
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  if (order.order_status !== "pending") {
    return NextResponse.json({ error: `Order is already ${order.order_status}` }, { status: 409 });
  }

  try {
    const booking = await bookCourierOrder(order);
    const manifest = await createManifest({
      order_id: order.id,
      courier_name: booking.courier_name,
      tracking_id: booking.tracking_id,
      pdf_label_url: booking.pdf_label_url,
      last_checkpoint: "booked",
    });
    await updateOrderStatus(order.id, "booked");
    await addTrackingEvent(order.id, `Booked with ${booking.courier_name}`, "booked");
    return NextResponse.json({ manifest });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Booking failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
