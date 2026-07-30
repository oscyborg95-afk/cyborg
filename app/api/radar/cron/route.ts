import { NextRequest, NextResponse } from "next/server";
import { getLatestRadarKeyword, runRadarScan } from "@/lib/product-radar";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const keyword = await getLatestRadarKeyword();
    return NextResponse.json({ ok: true, dashboard: await runRadarScan(keyword) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Product Radar scan failed";
    const status = error instanceof Error && error.name === "RadarScanConflict"
      ? 409
      : error instanceof Error && error.name === "RadarConfigurationError"
        ? 503
        : error instanceof Error && error.name === "RadarProviderTimeout"
          ? 504
          : error instanceof Error && error.name === "RadarProviderError"
            ? 502
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
