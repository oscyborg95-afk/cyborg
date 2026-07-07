import { NextRequest, NextResponse } from "next/server";
import { createOrder, getOrder } from "@/lib/db";

// Second-attempt flow for returned parcels: clone the order as a fresh pending
// one (same customer, items, and totals). The operator books it with the normal
// Book button once the customer confirms they still want it.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const order = await getOrder(id);
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  if (order.order_status !== "returned") {
    return NextResponse.json(
      { error: `Only returned orders can be re-booked (this one is ${order.order_status})` },
      { status: 409 }
    );
  }

  try {
    const clone = await createOrder({
      customer_name: order.customer_name,
      phone_number: order.phone_number,
      phone_2: order.phone_2,
      raw_address: order.raw_address,
      parsed_address: order.parsed_address,
      city: order.city,
      city_id: order.city_id,
      district: order.district,
      product_id: order.product_id,
      item_name: order.item_name,
      items: order.items,
      product_price: Number(order.product_price),
      shipping_fee: Number(order.shipping_fee),
      discount: Number(order.discount),
      total_cod: Number(order.total_cod),
    });
    return NextResponse.json({ order: clone }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Re-book failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
