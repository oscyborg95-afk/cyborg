import { NextResponse } from "next/server";
import {
  getSettings,
  listAdSpend,
  listAllOrders,
  listManifests,
  listProducts,
  listSettlementEvents,
} from "@/lib/db";
import { computeMetrics } from "@/lib/metrics";

export async function GET() {
  try {
    const [orders, manifests, settings, products, events, adSpend] = await Promise.all([
      // Lifetime counters (level, badges, monthly P&L) are cumulative, so the
      // metrics feed has to be every order — the 200-row operational cap froze
      // them in place once the shop passed 200 orders.
      listAllOrders(),
      listManifests(),
      getSettings(),
      listProducts(),
      listSettlementEvents(),
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
