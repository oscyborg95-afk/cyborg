import { NextRequest, NextResponse } from "next/server";
import { announcementBatchPrefix, getAnnouncementProgress } from "@/lib/announcements";
import { processTrackingNotificationQueue } from "@/lib/tracking-notifications";

// Sends one queued announcement per call. The compose screen calls this on a
// randomised 8–15s cadence — the same pacing the WhatsApp blast uses, because
// a burst from one number is what gets an account banned. Anything still
// queued when the operator closes the tab goes out on the next cron drain.
export async function POST(req: NextRequest) {
  const { batch_id: batchId } = await req.json();
  if (!batchId || typeof batchId !== "string") {
    return NextResponse.json({ error: "batch_id is required" }, { status: 400 });
  }
  try {
    const result = await processTrackingNotificationQueue(1, announcementBatchPrefix(batchId));
    const progress = await getAnnouncementProgress(batchId);
    return NextResponse.json({ ...progress, just_sent: result.sent, just_failed: result.failed });
  } catch (err) {
    console.error("Announcement drain failed", err);
    return NextResponse.json(
      { error: "The send stalled. Reload to see what already went out." },
      { status: 500 }
    );
  }
}
