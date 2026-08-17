import { NextRequest, NextResponse } from "next/server";
import {
  getFollowUpSettings,
  getSendPace,
  listEnrollments,
  listRecentSends,
  updateFollowUpSettings,
} from "@/lib/followups-db";
import { listCustomerProfiles } from "@/lib/crm-db";
import type { FollowUpSequence } from "@/lib/types";

export const dynamic = "force-dynamic";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function GET() {
  try {
    const [settings, enrollments, sends, pace, profiles] = await Promise.all([
      getFollowUpSettings(),
      listEnrollments(undefined, 200),
      listRecentSends(50),
      getSendPace(),
      listCustomerProfiles(),
    ]);
    const nameByKey = new Map(profiles.map((p) => [p.phone_key, p.display_name]));
    return NextResponse.json({
      settings,
      pace,
      enrollments: enrollments.map((e) => ({
        ...e,
        display_name: nameByKey.get(e.phone_key) ?? "",
      })),
      sends,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load follow-ups";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Sequences arrive whole from the editor. Validated here rather than trusted:
// this payload becomes the literal text sent to customers.
function sanitizeSequences(input: unknown): FollowUpSequence[] | undefined {
  if (!Array.isArray(input)) return undefined;
  return input.map((raw) => {
    const sequence = raw as Partial<FollowUpSequence>;
    return {
      trigger_state: sequence.trigger_state as FollowUpSequence["trigger_state"],
      enabled: Boolean(sequence.enabled),
      steps: (Array.isArray(sequence.steps) ? sequence.steps : []).map((step, index) => ({
        delay_hours: Math.max(
          // Under an hour is not a follow-up, it is a second message in the same
          // breath, and the cap keeps a typo from parking a lead for a year.
          1,
          Math.min(24 * 30, Number(step?.delay_hours) || 24)
        ),
        label: String(step?.label ?? `Step ${index + 1}`).slice(0, 60),
        variants: (Array.isArray(step?.variants) ? step.variants : [])
          .map((variant) => String(variant ?? "").slice(0, 2000).trim())
          .filter(Boolean),
      })),
    };
  });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const settings = await updateFollowUpSettings({
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(body.daily_cap !== undefined ? { daily_cap: Number(body.daily_cap) } : {}),
      ...(body.min_gap_minutes !== undefined
        ? { min_gap_minutes: Number(body.min_gap_minutes) }
        : {}),
      ...(TIME_RE.test(body.window_start) ? { window_start: body.window_start } : {}),
      ...(TIME_RE.test(body.window_end) ? { window_end: body.window_end } : {}),
      ...(body.sequences ? { sequences: sanitizeSequences(body.sequences) } : {}),
    });
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save follow-up settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
