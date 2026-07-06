import { NextResponse } from "next/server";
import {
  getSettings,
  listManifests,
  listOrders,
  listProducts,
  listTrackingEvents,
} from "@/lib/db";
import { computeMetrics } from "@/lib/metrics";

export async function GET() {
  try {
    const [orders, manifests, settings, products, events] = await Promise.all([
      listOrders(),
      listManifests(),
      getSettings(),
      listProducts(),
      listTrackingEvents(),
    ]);
    return NextResponse.json({
      metrics: computeMetrics(orders, manifests, settings, products, events),
      settings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compute metrics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
