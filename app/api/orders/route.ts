import { NextRequest, NextResponse } from "next/server";
import {
  createOrder,
  listAlertedOrderIds,
  listDeliveryAttempts,
  listLatestTrackingEvents,
  listManifests,
  listOrdersLite,
  listOrdersPage,
  usingSupabase,
} from "@/lib/db";
import type { NewOrder } from "@/lib/types";
import { stopFollowUpsForConversion } from "@/lib/followups";
import { itemsSummary, parseItems } from "@/lib/items";
import { codToCollect, orderValue, paymentMethodOf } from "@/lib/payments";

const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;

// Two shapes, both sized for database egress:
//  - ?view=lite → orders + manifests only (Workspace, Broadcast).
//  - default    → the Orders screen: the newest `limit` orders plus every
//    still-open order, each with only its latest checkpoint and a flag for
//    alert history. Full timelines and alert messages load per order from
//    /api/orders/:id/timeline when opened. Delivery attempts are read only
//    for parcels still with the courier — the rescue queue's whole input.
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const lite = params.get("view") === "lite";
  const requested = Number(params.get("limit"));
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), MAX_PAGE)
    : lite ? 200 : DEFAULT_PAGE;
  try {
    if (lite) {
      const orders = await listOrdersLite(limit);
      const manifests = await listManifests(orders.map((o) => o.id));
      return NextResponse.json({ orders, manifests });
    }
    const { orders, total } = await listOrdersPage(limit);
    const orderIds = orders.map((o) => o.id);
    const inFlight = orders.filter((o) => o.order_status === "booked").map((o) => o.id);
    const [manifests, latestEvents, alertedOrderIds, deliveryAttempts] = await Promise.all([
      listManifests(orderIds),
      listLatestTrackingEvents(orderIds),
      listAlertedOrderIds(orderIds),
      listDeliveryAttempts(inFlight),
    ]);
    return NextResponse.json({
      orders,
      total,
      limit,
      manifests,
      latestEvents,
      alertedOrderIds,
      deliveryAttempts,
      usingSupabase,
    });
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
  const paymentMethod = paymentMethodOf(body);
  const value = orderValue({
    product_price: productPrice,
    shipping_fee: shippingFee,
    discount,
  });

  try {
    const order = await createOrder({
      customer_name: body.customer_name!,
      sales_account_id: body.sales_account_id || null,
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
      total_cod: codToCollect(value, paymentMethod),
      payment_method: paymentMethod,
      replaces_order_id:
        paymentMethod === "replacement" ? body.replaces_order_id || null : null,
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
