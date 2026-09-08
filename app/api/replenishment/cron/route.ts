import { NextRequest, NextResponse } from "next/server";
import { runAutomaticReplenishment } from "@/lib/replenishment-db";
import { withTenant } from "@/lib/tenant-context";
import { listActiveTenants } from "@/lib/tenants";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const results = [];
  try {
    for (const tenant of await listActiveTenants()) {
      try { results.push({ tenantId: tenant.id, ...(await withTenant({ tenantId: tenant.id, userId: "replenishment-cron", role: "member", expiresAt: Date.now() + 300_000 }, () => runAutomaticReplenishment())) }); }
      catch (error) { results.push({ tenantId: tenant.id, errors: [error instanceof Error ? error.message : "Tenant run failed"] }); }
    }
    return NextResponse.json({ ok: true, tenants: results });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Cron failed" }, { status: 500 }); }
}
