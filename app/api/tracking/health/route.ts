import { NextResponse } from "next/server";
import { getTrackingHealth } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ health: await getTrackingHealth() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Tracking health unavailable" },
      { status: 500 }
    );
  }
}
