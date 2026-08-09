import { NextRequest, NextResponse } from "next/server";
import { runTrackingSync } from "@/app/api/track/sync/route";
import { withExclusiveTrackingSync } from "@/lib/db";
import { processTrackingNotificationQueue } from "@/lib/tracking-notifications";
import { withTenant } from "@/lib/tenant-context";
import { listActiveTenants } from "@/lib/tenants";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const tenants = await listActiveTenants();
    const results = [];
    for (const tenant of tenants) {
      results.push(await withTenant(
        { tenantId: tenant.id, userId: "tracking-cron", role: "member", expiresAt: Date.now() + 300_000 },
        async () => ({ tenantId: tenant.id, sync: await withExclusiveTrackingSync(runTrackingSync), notifications: await processTrackingNotificationQueue(100) })
      ));
    }
    return NextResponse.json({ ok: true, tenants: results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Tracking fallback failed" },
      { status: 500 }
    );
  }
}
