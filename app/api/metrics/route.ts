import { createHash } from "crypto";
import { NextResponse } from "next/server";
import {
  getMetricsDataVersion,
  getSettings,
  listAdSpend,
  listAllOrdersForMetrics,
  listManifestDispatches,
  listProducts,
  listSettlementEvents,
} from "@/lib/db";
import { computeMetrics, type Metrics } from "@/lib/metrics";
import { requireTenantSession } from "@/lib/tenant-context";

// Lifetime counters (level, badges, monthly P&L) are cumulative, so metrics
// need every order, manifest and settlement event — the biggest read in the
// app. Each instance keeps the last result per tenant and only re-reads when a
// one-row version check says the data moved, the day rolled over, or it is
// older than MAX_AGE_MS (time-relative figures such as "stale" drift slowly).
const MAX_AGE_MS = 5 * 60_000;
type CacheEntry = { key: string; at: number; metrics: Metrics };
const g = globalThis as unknown as { __metricsCache?: Map<string, CacheEntry> };
const cache = (g.__metricsCache ??= new Map());

const colomboDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" });

export async function GET() {
  try {
    const [tenant, settings, products, adSpend, version] = await Promise.all([
      requireTenantSession(),
      getSettings(),
      listProducts(),
      listAdSpend(),
      getMetricsDataVersion().catch(() => null),
    ]);
    const key = version
      ? createHash("sha256")
          .update(JSON.stringify([version, colomboDay.format(new Date()), settings, products, adSpend]))
          .digest("hex")
      : null;
    const hit = cache.get(tenant.tenantId);
    if (key && hit?.key === key && Date.now() - hit.at < MAX_AGE_MS) {
      return NextResponse.json({ metrics: hit.metrics, settings });
    }

    const [orders, manifests, events] = await Promise.all([
      listAllOrdersForMetrics(),
      listManifestDispatches(),
      listSettlementEvents(),
    ]);
    const metrics = computeMetrics(orders, manifests, settings, products, events, adSpend);
    if (key) cache.set(tenant.tenantId, { key, at: Date.now(), metrics });
    return NextResponse.json({ metrics, settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compute metrics";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
