import { NextRequest, NextResponse } from "next/server";
import { createOrder, listManifests, listOrders, usingSupabase } from "@/lib/db";
import type { NewOrder } from "@/lib/types";

export async function GET() {
  try {
    const [orders, manifests] = await Promise.all([listOrders(), listManifests()]);
    return NextResponse.json({ orders, manifests, usingSupabase });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load orders";
    return NextResponse.json({ error: message }, { status: 500 });
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

  const productPrice = Number(body.product_price ?? 0);
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
      district: body.district!,
      product_id: body.product_id || null,
      item_name: body.item_name ?? "",
      product_price: productPrice,
      shipping_fee: shippingFee,
      discount,
      total_cod: Math.max(0, productPrice + shippingFee - discount),
    });
    return NextResponse.json({ order }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save order";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
