import { NextResponse } from "next/server";
import {
  getSettings,
  listAdSpend,
  listManifests,
  listOrders,
  listProducts,
  listTrackingEvents,
} from "@/lib/db";
import { computeMetrics } from "@/lib/metrics";

export async function GET() {
  try {
    const [orders, manifests, settings, products, events, adSpend] = await Promise.all([
      listOrders(true),
      listManifests(),
      getSettings(),
      listProducts(),
      listTrackingEvents(),
      listAdSpend(),
    ]);
    return NextResponse.json({
      metrics: computeMetrics(orders, manifests, settings, products, events, adSpend),
      settings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compute metrics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
