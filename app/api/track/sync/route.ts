import { NextResponse } from "next/server";
import {
  addTrackingEvent,
  getLatestTrackingEvent,
  getSettings,
  listManifests,
  listOrders,
  updateManifestCheckpoint,
  updateOrderStatus,
} from "@/lib/db";
import { getTrackingStatus } from "@/lib/couriers";
import { makeTemplates } from "@/lib/templates";
import { phoneToChatId } from "@/lib/phone";
import { sendWhatsAppMessage } from "@/lib/wa";
import type { Order } from "@/lib/types";

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

type Templates = ReturnType<typeof makeTemplates>;

function alertFor(
  templates: Templates,
  outcome: string,
  checkpoint: string,
  trackingId: string
): string | null {
  if (outcome === "delivered") return templates.deliveredThanks();
  if (outcome === "returned") return templates.returnedApology();
  if (/out\s*for\s*deliver/i.test(checkpoint)) return templates.outForDelivery(trackingId);
  return null;
}

async function runSync() {
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

  const sendAlert = async (order: Order, text: string | null) => {
    if (!text) return;
    try {
      await sendWhatsAppMessage(phoneToChatId(order.phone_number), text);
      alertsSent++;
    } catch {
      // Worker offline or number unreachable — alerts are best-effort.
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
        await sendAlert(
          order,
          alertFor(templates, result.outcome, result.checkpoint, manifest.tracking_id)
        );
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
    return NextResponse.json(await runSync());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tracking sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  return POST();
}
