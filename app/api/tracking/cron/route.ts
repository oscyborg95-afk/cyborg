import { NextRequest, NextResponse } from "next/server";
import { runTrackingSync } from "@/app/api/track/sync/route";
import { withExclusiveTrackingSync } from "@/lib/db";
import { processTrackingNotificationQueue } from "@/lib/tracking-notifications";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const [sync, notifications] = await Promise.all([
      withExclusiveTrackingSync(runTrackingSync),
      processTrackingNotificationQueue(50),
    ]);
    return NextResponse.json({ ok: true, sync, notifications });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Tracking fallback failed" },
      { status: 500 }
    );
  }
}
