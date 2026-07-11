import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  addTrackingEvent, getLatestTrackingEvent, getSettings, hasSentAlert, listManifests, listOrders,
  recordCustomerAlert, updateManifestCheckpoint, updateOrderStatus,
} from "@/lib/db";
import {
  customerWebhookMessage, parseCourierWebhook, webhookCheckpoint,
} from "@/lib/courier-webhook";
import { phoneToChatId } from "@/lib/phone";
import { alertBodyFor, makeTemplates } from "@/lib/templates";
import { sendWhatsAppMessage } from "@/lib/wa";
import type { AlertKind } from "@/lib/types";

export const dynamic = "force-dynamic";

function validSecret(req: NextRequest): boolean {
  const expected = process.env.COURIER_WEBHOOK_SECRET;
  const received = req.nextUrl.searchParams.get("token") ?? "";
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readPayload(req: NextRequest): Promise<unknown> {
  const type = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("application/json")) return req.json();
  if (type.includes("form")) return Object.fromEntries((await req.formData()).entries());
  const text = await req.text();
  try { return JSON.parse(text); }
  catch { return Object.fromEntries(new URLSearchParams(text)); }
}

export async function POST(req: NextRequest) {
  if (!validSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const event = parseCourierWebhook(await readPayload(req));
  if (!event) {
    return NextResponse.json(
      { error: "Webhook payload needs a waybill and mapped status" },
      { status: 400 }
    );
  }

  const [orders, manifests, settings] = await Promise.all([
    listOrders(), listManifests(), getSettings(),
  ]);
  const manifest = manifests.find((item) => item.tracking_id === event.trackingId);
  const order = manifest ? orders.find((item) => item.id === manifest.order_id) : null;
  if (!manifest || !order) {
    return NextResponse.json({ error: "Unknown waybill" }, { status: 404 });
  }

  const checkpoint = webhookCheckpoint(event);
  const latest = await getLatestTrackingEvent(order.id);
  if (latest?.checkpoint === checkpoint) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  await updateManifestCheckpoint(manifest.id, checkpoint);
  await addTrackingEvent(order.id, checkpoint, event.status);
  if (event.status === "delivered") await updateOrderStatus(order.id, "delivered");
  if (event.status === "returned" || event.status === "cancelled") {
    await updateOrderStatus(order.id, "returned");
  }

  const failures: string[] = [];
  const standardKind: AlertKind | null =
    event.status === "out_for_delivery" ? "out_for_delivery"
      : event.status === "delivered" ? "delivered"
        : event.status === "returned" || event.status === "cancelled" ? "returned"
          : null;
  const alreadySent = standardKind ? await hasSentAlert(order.id, standardKind) : false;
  const customerMessage = standardKind
    ? alertBodyFor(makeTemplates(settings.templates), standardKind, event.trackingId)
    : customerWebhookMessage(event);
  if (customerMessage && !alreadySent) {
    await sendWhatsAppMessage(phoneToChatId(order.phone_number), customerMessage).catch(() => {
      failures.push("customer WhatsApp failed");
    });
    if (standardKind) {
      await recordCustomerAlert(
        order.id,
        standardKind,
        customerMessage,
        failures.includes("customer WhatsApp failed") ? "failed" : "sent"
      );
    }
  }

  if (event.status === "rescheduled" || event.status === "failed_to_deliver") {
    const ownerPhone = settings.business_phone_1.trim();
    if (ownerPhone) {
      const ownerMessage = [
        "⚠️ Delivery problem",
        `Order: ${order.order_no ?? order.id}`,
        `Customer: ${order.customer_name}`,
        `Phone: ${order.phone_number}`,
        `Tracking: ${event.trackingId}`,
        event.attempt ? `Attempt: ${event.attempt}` : "",
        event.remarks ? `Courier note: ${event.remarks}` : "",
      ].filter(Boolean).join("\n");
      await sendWhatsAppMessage(phoneToChatId(ownerPhone), ownerMessage).catch(() => {
        failures.push("owner WhatsApp failed");
      });
    } else {
      failures.push("business_phone_1 is empty");
    }
  }

  return NextResponse.json({ ok: true, duplicate: false, failures });
}
