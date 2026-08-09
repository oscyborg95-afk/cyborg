import { NextRequest, NextResponse } from "next/server";
import { getLatestRadarKeyword, runRadarScan } from "@/lib/product-radar";
import { withTenant } from "@/lib/tenant-context";
import { listActiveTenants } from "@/lib/tenants";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const tenants = await listActiveTenants();
    const dashboards = [];
    for (const tenant of tenants) {
      dashboards.push(await withTenant(
        { tenantId: tenant.id, userId: "radar-cron", role: "member", expiresAt: Date.now() + 300_000 },
        async () => ({ tenantId: tenant.id, dashboard: await runRadarScan(await getLatestRadarKeyword()) })
      ));
    }
    return NextResponse.json({ ok: true, tenants: dashboards });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Product Radar scan failed";
    const status = error instanceof Error && error.name === "RadarScanConflict"
      ? 409
      : error instanceof Error && error.name === "RadarConfigurationError"
        ? 503
        : error instanceof Error && error.name === "RadarProviderTimeout"
          ? 504
          : error instanceof Error && error.name === "RadarProviderError"
            ? 502
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
