import { NextRequest, NextResponse } from "next/server";
import { createOrder, createManifest, updateOrderStatus, upsertChatState } from "@/lib/db";
import { bookCourierOrder } from "@/lib/couriers";

// The one-click "Book & Print Waybill" action:
// save order → book courier → chat state = SHIPPED.
// The WhatsApp confirmation is NOT sent here — the operator reviews and sends
// it manually from the workspace (a booked parcel shouldn't auto-message).
export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    chat_id,
    customer_name,
    phone_number,
    phone_2 = "",
    raw_address = "",
    parsed_address,
    city = "",
    city_id = "",
    district,
    product_id = null,
    item_name = "",
    product_price = 0,
    shipping_fee = 0,
    discount = 0,
  } = body;

  if (!chat_id || !customer_name || !phone_number || !parsed_address || !district) {
    return NextResponse.json(
      { error: "chat_id, customer_name, phone_number, parsed_address and district are required" },
      { status: 400 }
    );
  }

  const productPrice = Number(product_price);
  const shippingFee = Number(shipping_fee);
  const discountValue = Number(discount);

  try {
    const order = await createOrder({
      customer_name,
      phone_number,
      phone_2,
      raw_address,
      parsed_address,
      city,
      district,
      product_id: product_id || null,
      item_name,
      product_price: productPrice,
      shipping_fee: shippingFee,
      discount: discountValue,
      total_cod: Math.max(0, productPrice + shippingFee - discountValue),
    });

    const cityId = Number(city_id) || null; // "" / 0 / NaN → resolve by name instead
    const booking = await bookCourierOrder({ ...order }, cityId);
    const manifest = await createManifest({
      order_id: order.id,
      courier_name: booking.courier_name,
      tracking_id: booking.tracking_id,
      pdf_label_url: booking.pdf_label_url,
      last_checkpoint: "booked",
    });
    await updateOrderStatus(order.id, "booked");
    await upsertChatState(phone_number, chat_id, "SHIPPED", customer_name);

    return NextResponse.json({ order, manifest });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dispatch failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
