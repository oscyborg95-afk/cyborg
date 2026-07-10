import { NextRequest, NextResponse } from "next/server";
import {
  bookOrderOnce,
  createOrder,
  upsertChatState,
} from "@/lib/db";
import { bookCourierOrder } from "@/lib/couriers";
import { itemsSummary, parseItems } from "@/lib/items";

// The one-click "Book & Print Waybill" action:
// save order → book courier → chat state = SHIPPED.
// The WhatsApp confirmation is NOT sent here — the operator reviews and sends
// it manually from the workspace (a booked parcel shouldn't auto-message).
export async function POST(req: NextRequest) {
  const body = await req.json();
  const idempotencyKey = req.headers.get("idempotency-key")?.trim() ?? "";
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
    items: rawItems = null,
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
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return NextResponse.json(
      { error: "A valid Idempotency-Key header is required" },
      { status: 400 }
    );
  }

  const items = parseItems(rawItems);
  // Line items are the source of truth for the products subtotal when present.
  const productPrice = items
    ? items.reduce((sum, i) => sum + i.qty * i.price, 0)
    : Number(product_price);
  const shippingFee = Number(shipping_fee);
  const discountValue = Number(discount);
  const cityId = Number(city_id) || null; // "" / 0 / NaN → resolve by name instead

  try {
    // The pending order is created on its own first: if the courier booking
    // throws, it stays as a reviewable pending order rather than vanishing.
    const pendingOrder = await createOrder({
      customer_name,
      phone_number,
      phone_2,
      raw_address,
      parsed_address,
      city,
      city_id: cityId,
      district,
      product_id: items ? (items[0]?.product_id ?? null) : product_id || null,
      item_name: items ? itemsSummary(items) : item_name,
      items,
      product_price: productPrice,
      shipping_fee: shippingFee,
      discount: discountValue,
      total_cod: Math.max(0, productPrice + shippingFee - discountValue),
    }, undefined, idempotencyKey);

    const booked = await bookOrderOnce(pendingOrder.id, (order) =>
      bookCourierOrder(order, order.city_id)
    );
    await upsertChatState(phone_number, chat_id, "SHIPPED", customer_name);

    return NextResponse.json({
      order: booked.order,
      manifest: booked.manifest,
      reused: booked.reused,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Dispatch failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
