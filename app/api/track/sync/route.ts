import { NextResponse } from "next/server";
import {
  addTrackingEvent,
  getLatestTrackingEvent,
  getSettings,
  hasSentAlert,
  listManifests,
  listOrders,
  recordCustomerAlert,
  updateManifestCheckpoint,
  updateOrderStatus,
  withExclusiveTrackingSync,
} from "@/lib/db";
import { getTrackingStatus } from "@/lib/couriers";
import { alertBodyFor, makeTemplates } from "@/lib/templates";
import { phoneToChatId } from "@/lib/phone";
import { sendWhatsAppMessage } from "@/lib/wa";
import type { AlertKind, Order } from "@/lib/types";

// Sweep every order riding with the courier and pull its latest status.
// delivered → order delivered (feeds levels), returned → order returned
// (puts the unit back in product stock via the status transition logic).
//
// Proactive customer alerts ride on the same sweep: when a checkpoint changes,
// the customer gets the matching Sinhala WhatsApp message automatically —
// "out for delivery" nudges cut refusal-at-door, the returned apology opens
// the redelivery conversation. Alert failures (worker offline, unlinked
// session) never fail the sync; the status updates always land.
//
// POST is what the UI calls; GET does the same so a cron (Vercel cron, uptime
// pinger, etc.) can drive the sweep in the background.

// Which tracking alert (if any) a checkpoint change should send.
function alertKindFor(outcome: string, checkpoint: string): AlertKind | null {
  if (outcome === "delivered") return "delivered";
  if (outcome === "returned") return "returned";
  if (/out\s*for\s*deliver/i.test(checkpoint)) return "out_for_delivery";
  return null;
}

export async function runTrackingSync() {
  const [orders, manifests, settings] = await Promise.all([
    listOrders(),
    listManifests(),
    getSettings().catch(() => null),
  ]);
  const templates = makeTemplates(settings?.templates ?? {});
  const manifestByOrder = new Map(manifests.map((m) => [m.order_id, m]));

  const inFlight = orders.filter(
    (o) => o.order_status === "booked" && manifestByOrder.has(o.id)
  );

  let delivered = 0;
  let returned = 0;
  let inTransit = 0;
  let alertsSent = 0;
  const failures: string[] = [];

  // Send a tracking alert at most once per (order, kind), and persist the
  // outcome either way — a 'sent' row blocks re-sends, a 'failed' row stays
  // visible for a manual retry instead of vanishing silently.
  const sendAlert = async (order: Order, kind: AlertKind, trackingId: string) => {
    if (await hasSentAlert(order.id, kind)) return;
    const text = alertBodyFor(templates, kind, trackingId);
    try {
      await sendWhatsAppMessage(phoneToChatId(order.phone_number), text);
      await recordCustomerAlert(order.id, kind, text, "sent");
      alertsSent++;
    } catch {
      // Worker offline or number unreachable — record the miss, never fail sync.
      await recordCustomerAlert(order.id, kind, text, "failed").catch(() => {});
    }
  };

  for (const order of inFlight) {
    const manifest = manifestByOrder.get(order.id)!;
    try {
      const result = await getTrackingStatus(manifest.tracking_id, manifest.created_at);
      await updateManifestCheckpoint(manifest.id, result.checkpoint);
      // Append a timeline event (and alert the customer) only when the
      // checkpoint actually changed, so repeated syncs don't spam either.
      const last = await getLatestTrackingEvent(order.id);
      const changed = !last || last.checkpoint !== result.checkpoint;
      if (changed) {
        await addTrackingEvent(order.id, result.checkpoint, result.outcome);
      }
      if (result.outcome === "delivered") {
        await updateOrderStatus(order.id, "delivered");
        delivered++;
      } else if (result.outcome === "returned") {
        await updateOrderStatus(order.id, "returned");
        returned++;
      } else {
        inTransit++;
      }
      if (changed) {
        const kind = alertKindFor(result.outcome, result.checkpoint);
        if (kind) await sendAlert(order, kind, manifest.tracking_id);
      }
    } catch (err) {
      failures.push(
        `${manifest.tracking_id}: ${err instanceof Error ? err.message : "failed"}`
      );
    }
  }

  return { checked: inFlight.length, delivered, returned, inTransit, alertsSent, failures };
}

export async function POST() {
  try {
    const result = await withExclusiveTrackingSync(runTrackingSync);
    if (result === null) {
      return NextResponse.json({
        skipped: true,
        checked: 0,
        delivered: 0,
        returned: 0,
        inTransit: 0,
        alertsSent: 0,
        failures: [],
      });
    }
    return NextResponse.json({ ...result, skipped: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tracking sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
