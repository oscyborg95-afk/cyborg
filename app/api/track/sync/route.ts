import { NextResponse } from "next/server";
import {
  listInFlightTrackedOrders,
  withExclusiveTrackingSync,
} from "@/lib/db";
import { getCourierTrackingHistory } from "@/lib/couriers";
import { normalizeCourierHistory } from "@/lib/delivery-events";
import { processDeliveryEvent } from "@/lib/delivery-workflow";
import { processTrackingNotificationQueue } from "@/lib/tracking-notifications";

// Reconcile the courier's complete public history, not only its latest status.
// This recovers reschedules that happened between polls and makes webhook
// delivery a low-latency optimization rather than a single point of failure.
// Only these statuses are worth a WhatsApp; everything else is a silent
// checkpoint update. Branch movements alert the owner but never the customer
// (see delivery-workflow), so they still count as actionable here.
const ACTIONABLE = new Set([
  "out_for_delivery",
  "rescheduled",
  "branch_rescheduled",
  "failed_to_deliver",
  "branch_failed",
  "delivered",
  "returned_to_ho",
]);

// One courier round trip per parcel, so a shop with hundreds in flight cannot
// be walked serially inside a serverless function's lifetime. Parcels come back
// least-recently-updated first, so a run that hits the budget simply resumes
// with the same stale ones next time instead of starving them.
const SYNC_CONCURRENCY = 5;
const SYNC_BUDGET_MS = (() => {
  const configured = Number(process.env.TRACKING_SYNC_BUDGET_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 45_000;
})();

export async function runTrackingSync() {
  const inFlight = await listInFlightTrackedOrders();
  const deadline = Date.now() + SYNC_BUDGET_MS;

  let delivered = 0;
  let returned = 0;
  let inTransit = 0;
  let eventsAccepted = 0;
  let checked = 0;
  const failures: string[] = [];

  let cursor = 0;
  async function worker() {
    while (cursor < inFlight.length && Date.now() < deadline) {
      const { manifest } = inFlight[cursor++];
      checked++;
      try {
        const history = await getCourierTrackingHistory(manifest.tracking_id);
        const events = normalizeCourierHistory(manifest.tracking_id, history);
        let notificationIndex = -1;
        for (let index = events.length - 1; index >= 0; index--) {
          if (ACTIONABLE.has(events[index].status)) {
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
  }

  await Promise.all(
    Array.from({ length: Math.min(SYNC_CONCURRENCY, inFlight.length) }, worker)
  );

  return {
    checked,
    delivered,
    returned,
    inTransit,
    eventsAccepted,
    alertsSent: 0,
    // A non-zero remaining count is normal on a large shop: the next run picks
    // these up first. It is only a problem if it never falls.
    remaining: Math.max(inFlight.length - checked, 0),
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
        remaining: 0,
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
