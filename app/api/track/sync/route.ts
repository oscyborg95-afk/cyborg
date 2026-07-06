import { NextResponse } from "next/server";
import {
  listManifests,
  listOrders,
  updateManifestCheckpoint,
  updateOrderStatus,
} from "@/lib/db";
import { getTrackingStatus } from "@/lib/couriers";

// Sweep every order riding with the courier and pull its latest status.
// delivered → order delivered (feeds levels), returned → order returned
// (puts the unit back in product stock via the status transition logic).
export async function POST() {
  try {
    const [orders, manifests] = await Promise.all([listOrders(), listManifests()]);
    const manifestByOrder = new Map(manifests.map((m) => [m.order_id, m]));

    const inFlight = orders.filter(
      (o) => o.order_status === "booked" && manifestByOrder.has(o.id)
    );

    let delivered = 0;
    let returned = 0;
    let inTransit = 0;
    const failures: string[] = [];

    for (const order of inFlight) {
      const manifest = manifestByOrder.get(order.id)!;
      try {
        const result = await getTrackingStatus(manifest.tracking_id, manifest.created_at);
        await updateManifestCheckpoint(manifest.id, result.checkpoint);
        if (result.outcome === "delivered") {
          await updateOrderStatus(order.id, "delivered");
          delivered++;
        } else if (result.outcome === "returned") {
          await updateOrderStatus(order.id, "returned");
          returned++;
        } else {
          inTransit++;
        }
      } catch (err) {
        failures.push(
          `${manifest.tracking_id}: ${err instanceof Error ? err.message : "failed"}`
        );
      }
    }

    return NextResponse.json({
      checked: inFlight.length,
      delivered,
      returned,
      inTransit,
      failures,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Tracking sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
