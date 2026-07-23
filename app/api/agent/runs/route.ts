import { NextRequest, NextResponse } from "next/server";
import { listAgentRuns } from "@/lib/crm-db";

export async function GET(req: NextRequest) {
  const phoneKey = req.nextUrl.searchParams.get("phone") || undefined;
  try {
    return NextResponse.json({ runs: await listAgentRuns(phoneKey, 100) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load agent activity";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
