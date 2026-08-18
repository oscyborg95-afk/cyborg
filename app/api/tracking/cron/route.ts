import { NextRequest, NextResponse } from "next/server";
import { runTrackingSync } from "@/app/api/track/sync/route";
import { withExclusiveTrackingSync } from "@/lib/db";
import { processTrackingNotificationQueue } from "@/lib/tracking-notifications";
import { withTenant } from "@/lib/tenant-context";
import { listActiveTenants } from "@/lib/tenants";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Two jobs behind one entry point:
//
//   ?mode=drain  — only flush the notification outbox. No courier calls, so it
//                  is cheap enough to run every couple of minutes. Reminders
//                  are queued for a wall-clock time (the owner's 07:00 "delivery
//                  today" nudge); without a frequent drain they sat in the queue
//                  until the next full sync, which is to say the next midnight.
//   ?mode=sync   — the full courier reconciliation (default, unchanged).
//
// Both are per-tenant and safe to overlap: the sync takes a per-tenant advisory
// lock and the drain claims jobs with FOR UPDATE SKIP LOCKED.
export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const mode = req.nextUrl.searchParams.get("mode") === "drain" ? "drain" : "sync";
  try {
    const tenants = await listActiveTenants();
    const results = [];
    for (const tenant of tenants) {
      // One tenant's courier outage must not stop every later tenant's
      // notifications from going out.
      try {
        results.push(
          await withTenant(
            {
              tenantId: tenant.id,
              userId: "tracking-cron",
              role: "member",
              expiresAt: Date.now() + 300_000,
            },
            async () => {
              // Drain first, sync second — never the other way round. The
              // reconciliation can burn this function's whole 60s budget, and
              // when it did, the outbox that ran after it was simply never
              // reached: every delivery notification stopped going out while
              // the queue kept filling from the webhook.
              const started = Date.now();
              const notifications = await processTrackingNotificationQueue(25);
              // Only reconcile with time actually left to do it in; a sync that
              // is going to time out anyway must not also cost us the next
              // tick's drain.
              const syncable = mode === "sync" && Date.now() - started < 20_000;
              return {
                tenantId: tenant.id,
                notifications,
                sync: syncable ? await withExclusiveTrackingSync(runTrackingSync) : null,
                syncSkipped: mode === "sync" && !syncable,
              };
            }
          )
        );
      } catch (err) {
        results.push({
          tenantId: tenant.id,
          error: err instanceof Error ? err.message : "Tenant run failed",
        });
      }
    }
    return NextResponse.json({ ok: true, mode, tenants: results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Tracking fallback failed" },
      { status: 500 }
    );
  }
}
