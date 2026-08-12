import { createHash, timingSafeEqual } from "crypto";
import { after, NextRequest, NextResponse } from "next/server";
import {
  getTrackedOrderByWaybill,
  ingestCourierWebhook,
} from "@/lib/db";
import {
  inspectCourierWebhook,
  webhookCheckpoint,
} from "@/lib/courier-webhook";
import { normalizeWebhookEvent } from "@/lib/delivery-events";
import { processDeliveryEvent } from "@/lib/delivery-workflow";
import { processTrackingNotificationQueue } from "@/lib/tracking-notifications";
import { withTenant } from "@/lib/tenant-context";
import { findTenantForWaybill } from "@/lib/tenants";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const MAX_BODY_BYTES = 32_000;

function validSecret(request: NextRequest): boolean {
  const expected = process.env.COURIER_WEBHOOK_SECRET;
  const received =
    request.headers.get("x-courier-webhook-secret") ??
    request.nextUrl.searchParams.get("token") ??
    "";
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readPayload(request: NextRequest): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error("Payload too large");
  const type = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("json") || text.trim().startsWith("{")) {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Payload must be an object");
    }
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

// Every string the courier sent, at any nesting depth, so the reschedule-date
// scan is not limited to the one field we happened to map.
function payloadTexts(value: unknown, depth = 0): string[] {
  if (depth > 4 || !value || typeof value !== "object") return [];
  const out: string[] = [];
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (typeof child === "string") out.push(child);
    else if (child && typeof child === "object") out.push(...payloadTexts(child, depth + 1));
  }
  return out;
}

export async function POST(request: NextRequest) {
  if (!validSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let payload: Record<string, unknown>;
  try {
    payload = await readPayload(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid payload" },
      { status: 400 }
    );
  }
  const inspected = inspectCourierWebhook(payload);
  if (!inspected.event) {
    return NextResponse.json(
      {
        error: "Invalid webhook payload",
        missing: inspected.missing,
        observedKeys: inspected.observedKeys,
      },
      { status: 400 }
    );
  }
  const event = inspected.event;
  const tenant = await findTenantForWaybill(event.trackingId);
  if (!tenant) return NextResponse.json({ error: "Unknown waybill" }, { status: 404 });
  return withTenant(
    { tenantId: tenant.id, userId: "courier-webhook", role: "member", expiresAt: Date.now() + 60_000 },
    async () => {
  const tracked = await getTrackedOrderByWaybill(event.trackingId);
  if (!tracked) return NextResponse.json({ error: "Unknown waybill" }, { status: 404 });

  const fingerprint = createHash("sha256")
    .update(`${event.trackingId}\n${event.status}\n${stable(payload)}`)
    .digest("hex");
  try {
    const inbox = await ingestCourierWebhook({
      fingerprint,
      tracking_id: event.trackingId,
      status: event.status,
      checkpoint: webhookCheckpoint(event),
      attempt: event.attempt,
      payload: { ...payload, _observed_keys: inspected.observedKeys },
      notifications: [],
    });
    // One normalizer for both ingestion paths. The reschedule date is also
    // hunted for across the whole payload, not just `remarks`: couriers put it
    // in a different field depending on the callback, and a date the webhook
    // misses but the poller finds produces two different dedupe keys — which is
    // exactly how the customer ended up with duplicate reschedule messages.
    const normalized = normalizeWebhookEvent(event, fingerprint, payloadTexts(payload));
    if (normalized) {
      await processDeliveryEvent(normalized, "webhook");
    }
    after(() => processTrackingNotificationQueue(50));
    return NextResponse.json(
      {
        ok: true,
        accepted: !inbox.duplicate,
        duplicate: inbox.duplicate,
        eventId: inbox.event_id,
      },
      { status: inbox.duplicate ? 200 : 202 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Webhook persistence failed";
    return NextResponse.json(
      { error: message },
      { status: message === "Unknown waybill" ? 404 : 500 }
    );
  }
    }
  );
}
