import { NextResponse } from "next/server";
import {
  listManifests,
  listOrders,
  withExclusiveTrackingSync,
} from "@/lib/db";
import { getCourierTrackingHistory } from "@/lib/couriers";
import { normalizeCourierHistory } from "@/lib/delivery-events";
import { processDeliveryEvent } from "@/lib/delivery-workflow";
import { processTrackingNotificationQueue } from "@/lib/tracking-notifications";

// Reconcile the courier's complete public history, not only its latest status.
// This recovers reschedules that happened between polls and makes webhook
// delivery a low-latency optimization rather than a single point of failure.
export async function runTrackingSync() {
  const [orders, manifests] = await Promise.all([listOrders(), listManifests()]);
  const manifestByOrder = new Map(manifests.map((manifest) => [manifest.order_id, manifest]));
  const inFlight = orders.filter((order) =>
    order.order_status === "booked" && manifestByOrder.has(order.id)
  );

  let delivered = 0;
  let returned = 0;
  let inTransit = 0;
  let eventsAccepted = 0;
  const failures: string[] = [];

  for (const order of inFlight) {
    const manifest = manifestByOrder.get(order.id)!;
    try {
      const history = await getCourierTrackingHistory(manifest.tracking_id);
      const events = normalizeCourierHistory(manifest.tracking_id, history);
      const actionable = new Set([
        "out_for_delivery",
        "rescheduled",
        "failed_to_deliver",
        "delivered",
        "returned_to_ho",
      ]);
      let notificationIndex = -1;
      for (let index = events.length - 1; index >= 0; index--) {
        if (actionable.has(events[index].status)) {
          notificationIndex = index;
          break;
        }
      }
      for (const [index, event] of events.entries()) {
        const result = await processDeliveryEvent(event, "poll", index === notificationIndex);
        if (!result.duplicate) eventsAccepted++;
      }
      const latest = events.at(-1);
      if (latest?.status === "delivered") delivered++;
      else if (latest?.status === "returned_to_ho") returned++;
      else inTransit++;
    } catch (error) {
      failures.push(
        `${manifest.tracking_id}: ${error instanceof Error ? error.message : "failed"}`
      );
    }
  }

  return {
    checked: inFlight.length,
    delivered,
    returned,
    inTransit,
    eventsAccepted,
    alertsSent: 0,
    failures,
  };
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
        eventsAccepted: 0,
        alertsSent: 0,
        failures: [],
      });
    }
    const notifications = await processTrackingNotificationQueue(100);
    return NextResponse.json({
      ...result,
      alertsSent: notifications.sent,
      notificationFailures: notifications.failed,
      skipped: false,
    });
  } catch (error) {
    console.error("Tracking sync failed", error);
    return NextResponse.json(
      { error: "Courier tracking could not be refreshed. Please try again shortly." },
      { status: 500 }
    );
  }
}
