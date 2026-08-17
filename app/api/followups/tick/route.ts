import { NextRequest, NextResponse } from "next/server";
import { runFollowUpSweep } from "@/lib/followups";
import { withTenant } from "@/lib/tenant-context";
import { listActiveTenants } from "@/lib/tenants";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// The heartbeat of the follow-up engine. Called every couple of minutes by the
// WhatsApp worker (worker/index.js) and by the Vercel cron as a fallback.
//
// Each tick sends at most `maxSends` messages — pacing lives here rather than in
// a sleep loop, so a slow trickle across the day costs nothing and no request
// ever sits open waiting to send the next one.
export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const requested = Number(req.nextUrl.searchParams.get("max") || 1);
  const maxSends = Number.isFinite(requested) ? Math.max(1, Math.min(5, requested)) : 1;

  try {
    const tenants = await listActiveTenants();
    const results = [];
    for (const tenant of tenants) {
      // One tenant's offline WhatsApp socket must not stop every later tenant's
      // follow-ups for the rest of the day.
      try {
        results.push(
          await withTenant(
            {
              tenantId: tenant.id,
              userId: "followup-cron",
              role: "member",
              expiresAt: Date.now() + 300_000,
            },
            async () => ({ tenantId: tenant.id, ...(await runFollowUpSweep({ maxSends })) })
          )
        );
      } catch (err) {
        results.push({
          tenantId: tenant.id,
          error: err instanceof Error ? err.message : "Follow-up sweep failed",
        });
      }
    }
    return NextResponse.json({ ok: true, tenants: results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Follow-up tick failed" },
      { status: 500 }
    );
  }
}
