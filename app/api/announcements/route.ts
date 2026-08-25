import { NextRequest, NextResponse } from "next/server";
import {
  EmptyAnnouncementBodyError,
  listAnnouncementRecipients,
  parseAudiences,
  queueAnnouncement,
  RECENT_CONTACT_HOURS,
} from "@/lib/announcements";
import { getSettings } from "@/lib/db";

// A blast this size is already at the edge of what WhatsApp tolerates from one
// number in a sitting; beyond it the operator should split across days.
const MAX_RECIPIENTS_PER_BATCH = 100;

export async function GET(req: NextRequest) {
  try {
    const audiences = parseAudiences(req.nextUrl.searchParams.get("audience"));
    const [recipients, settings] = await Promise.all([
      listAnnouncementRecipients(audiences),
      getSettings(),
    ]);
    return NextResponse.json({
      recipients,
      audiences,
      business_name: settings.business_name,
      recent_contact_hours: RECENT_CONTACT_HOURS,
      max_per_batch: MAX_RECIPIENTS_PER_BATCH,
    });
  } catch (err) {
    console.error("Announcement audience load failed", err);
    return NextResponse.json(
      { error: "The audience could not be loaded. Please try again." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const text = typeof body.body === "string" ? body.body.trim() : "";
  const phoneKeys: string[] = Array.isArray(body.phone_keys)
    ? body.phone_keys.filter((key: unknown): key is string => typeof key === "string")
    : [];
  const audiences = parseAudiences(
    Array.isArray(body.audiences) ? body.audiences.join(",") : null
  );

  if (!text) {
    return NextResponse.json({ error: "Type the message you want to send." }, { status: 400 });
  }
  if (phoneKeys.length === 0) {
    return NextResponse.json({ error: "Select at least one customer." }, { status: 400 });
  }
  if (phoneKeys.length > MAX_RECIPIENTS_PER_BATCH) {
    return NextResponse.json(
      { error: `Send to at most ${MAX_RECIPIENTS_PER_BATCH} customers at a time.` },
      { status: 400 }
    );
  }

  try {
    const result = await queueAnnouncement({ body: text, phoneKeys, audiences });
    if (result.recipients === 0) {
      return NextResponse.json(
        { error: "None of those customers still have an open order." },
        { status: 409 }
      );
    }
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof EmptyAnnouncementBodyError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Announcement queue failed", err);
    return NextResponse.json(
      { error: "The announcement could not be queued. Nothing was sent." },
      { status: 500 }
    );
  }
}
