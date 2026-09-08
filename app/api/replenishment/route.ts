import { NextResponse } from "next/server";
import { getReplenishmentDashboard } from "@/lib/replenishment-db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getReplenishmentDashboard());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Stock analysis failed" }, { status: 500 });
  }
}
