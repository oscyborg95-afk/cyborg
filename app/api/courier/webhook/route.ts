import { createHash, timingSafeEqual } from "crypto";
import { after, NextRequest, NextResponse } from "next/server";
import {
  getSettings,
  getTrackedOrderByWaybill,
  hasSentAlert,
  ingestCourierWebhook,
  type WebhookNotificationInput,
} from "@/lib/db";
import {
  customerWebhookMessage,
  inspectCourierWebhook,
  webhookCheckpoint,
} from "@/lib/courier-webhook";
import { phoneToChatId } from "@/lib/phone";
import { alertBodyFor, makeTemplates } from "@/lib/templates";
import { processTrackingNotificationQueue } from "@/lib/tracking-notifications";
import type { AlertKind, OrderStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const MAX_BODY_BYTES = 32_000;

function validSecret(req: NextRequest): boolean {
  const expected = process.env.COURIER_WEBHOOK_SECRET;
  const received = req.nextUrl.searchParams.get("token") ?? "";
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readPayload(req: NextRequest): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error("Payload too large");
  const type = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("json") || text.trim().startsWith("{")) {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Payload must be an object");
    return parsed as Record<string, unknown>;
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function POST(req: NextRequest) {
  if (!validSecret(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let payload: Record<string, unknown>;
  try {
    payload = await readPayload(req);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid payload" }, { status: 400 });
  }
  const inspected = inspectCourierWebhook(payload);
  if (!inspected.event) {
    return NextResponse.json(
      { error: "Invalid webhook payload", missing: inspected.missing, observedKeys: inspected.observedKeys },
      { status: 400 }
    );
  }
  const event = inspected.event;
  const tracked = await getTrackedOrderByWaybill(event.trackingId);
  if (!tracked) return NextResponse.json({ error: "Unknown waybill" }, { status: 404 });

  const settings = await getSettings();
  const standardKind: AlertKind | null =
    event.status === "out_for_delivery" ? "out_for_delivery"
      : event.status === "delivered" ? "delivered"
        : event.status === "returned" || event.status === "cancelled" ? "returned"
          : null;
  const notifications: WebhookNotificationInput[] = [];
  const templates = makeTemplates(settings.templates);
  const customerMessage = standardKind
    ? alertBodyFor(templates, standardKind, event.trackingId)
    : event.status === "rescheduled" || event.status === "failed_to_deliver"
      ? templates.rescheduledDelivery(event.trackingId)
      : customerWebhookMessage(event);
  if (customerMessage && (!standardKind || !(await hasSentAlert(tracked.order.id, standardKind)))) {
    notifications.push({
      recipient: "customer", alert_kind: standardKind,
      chat_id: phoneToChatId(tracked.order.phone_number), body: customerMessage,
    });
  }
  if (event.status === "rescheduled" || event.status === "failed_to_deliver") {
    const ownerPhone = settings.business_phone_1.trim();
    if (ownerPhone) {
      notifications.push({
        recipient: "owner", alert_kind: null, chat_id: phoneToChatId(ownerPhone),
        body: [
          "⚠️ Delivery problem",
          `Order: ${tracked.order.order_no ?? tracked.order.id}`,
          `Customer: ${tracked.order.customer_name}`,
          `Phone: ${tracked.order.phone_number}`,
          tracked.order.phone_2 ? `Phone 2: ${tracked.order.phone_2}` : "",
          `Tracking: ${event.trackingId}`,
          event.attempt ? `Attempt: ${event.attempt}` : "",
          event.remarks ? `Courier note: ${event.remarks}` : "",
        ].filter(Boolean).join("\n"),
      });
    }
  }

  const terminalStatus: OrderStatus | undefined = event.status === "delivered"
    ? "delivered"
    : event.status === "returned" || event.status === "cancelled" ? "returned" : undefined;
  const fingerprint = createHash("sha256")
    .update(`${event.trackingId}\n${event.status}\n${stable(payload)}`)
    .digest("hex");
  try {
    const result = await ingestCourierWebhook({
      fingerprint, tracking_id: event.trackingId, status: event.status,
      checkpoint: webhookCheckpoint(event), attempt: event.attempt,
      payload: { ...payload, _observed_keys: inspected.observedKeys },
      notifications, terminal_status: terminalStatus,
    });
    if (!result.duplicate) after(() => processTrackingNotificationQueue());
    return NextResponse.json(
      { ok: true, accepted: !result.duplicate, duplicate: result.duplicate, eventId: result.event_id },
      { status: result.duplicate ? 200 : 202 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook persistence failed";
    return NextResponse.json({ error: message }, { status: message === "Unknown waybill" ? 404 : 500 });
  }
}
