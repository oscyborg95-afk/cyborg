import { NextRequest, NextResponse } from "next/server";
import { stopEnrollment } from "@/lib/followups-db";

export const dynamic = "force-dynamic";

// Operator override: take a lead out of the queue by hand ("I already called
// this one"). Next.js 16 hands route params in as a promise.
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await stopEnrollment(id, "stopped", "Stopped by operator");
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to stop follow-up";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
