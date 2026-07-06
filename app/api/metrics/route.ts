import { NextResponse } from "next/server";
import { getSettings, listManifests, listOrders, listProducts } from "@/lib/db";
import { computeMetrics } from "@/lib/metrics";

export async function GET() {
  try {
    const [orders, manifests, settings, products] = await Promise.all([
      listOrders(),
      listManifests(),
      getSettings(),
      listProducts(),
    ]);
    return NextResponse.json({
      metrics: computeMetrics(orders, manifests, settings, products),
      settings,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compute metrics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
