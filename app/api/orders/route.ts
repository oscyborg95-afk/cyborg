import { NextRequest, NextResponse } from "next/server";
import {
  createOrder,
  listDeliveryAttempts,
  listCustomerAlerts,
  listManifests,
  listOrders,
  listTrackingEvents,
  usingSupabase,
} from "@/lib/db";
import type { NewOrder } from "@/lib/types";
import { stopFollowUpsForConversion } from "@/lib/followups";
import { itemsSummary, parseItems } from "@/lib/items";

export async function GET() {
  try {
    const [orders, manifests, events, alerts, deliveryAttempts] = await Promise.all([
      listOrders(),
      listManifests(),
      listTrackingEvents(),
      listCustomerAlerts(),
      listDeliveryAttempts(),
    ]);
    return NextResponse.json({ orders, manifests, events, alerts, deliveryAttempts, usingSupabase });
  } catch (err) {
    console.error("Orders load failed", err);
    return NextResponse.json(
      { error: "Order data could not be loaded. Please try again. If this continues, contact support." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<NewOrder>;

  const required = ["customer_name", "phone_number", "parsed_address", "district"] as const;
  for (const field of required) {
    if (!body[field] || typeof body[field] !== "string") {
      return NextResponse.json({ error: `${field} is required` }, { status: 400 });
    }
  }

  const items = parseItems(body.items);
  const productPrice = items
    ? items.reduce((sum, i) => sum + i.qty * i.price, 0)
    : Number(body.product_price ?? 0);
  const shippingFee = Number(body.shipping_fee ?? 0);
  const discount = Number(body.discount ?? 0);

  try {
    const order = await createOrder({
      customer_name: body.customer_name!,
      phone_number: body.phone_number!,
      phone_2: body.phone_2 ?? "",
      raw_address: body.raw_address ?? "",
      parsed_address: body.parsed_address!,
      city: body.city ?? "",
      city_id: body.city_id ?? null,
      district: body.district!,
      product_id: items ? (items[0]?.product_id ?? null) : body.product_id || null,
      item_name: items ? itemsSummary(items) : (body.item_name ?? ""),
      items,
      product_price: productPrice,
      shipping_fee: shippingFee,
      discount,
      total_cod: Math.max(0, productPrice + shippingFee - discount),
    });
    // The lead converted — nothing should keep chasing them for an address or a
    // confirmation. Never let this fail the order that was actually saved.
    await stopFollowUpsForConversion(order.phone_number).catch(() => null);
    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    console.error("Order save failed", err);
    return NextResponse.json(
      { error: "The order could not be saved. Please try again." },
      { status: 500 }
    );
  }
}
