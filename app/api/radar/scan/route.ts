import { NextResponse } from "next/server";
import { runRadarScan } from "@/lib/product-radar";
import { parseRadarScanPayload } from "@/lib/radar-keyword";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Send valid JSON with a keyword, for example {\"keyword\":\"face serum\"}." },
      { status: 400 }
    );
  }
  const validation = parseRadarScanPayload(payload);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  try {
    return NextResponse.json(await runRadarScan(validation.keyword));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Product Radar scan failed";
    const status = error instanceof Error && error.name === "RadarValidationError"
      ? 400
      : error instanceof Error && error.name === "RadarScanConflict"
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
