import { NextResponse } from "next/server";
import { runRadarScan } from "@/lib/product-radar";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  try {
    return NextResponse.json(await runRadarScan());
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
