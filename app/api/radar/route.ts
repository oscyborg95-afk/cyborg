import { NextResponse } from "next/server";
import { getRadarDashboard } from "@/lib/product-radar";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getRadarDashboard());
  } catch (error) {
    const diagnosticId = crypto.randomUUID().slice(0, 8);
    console.error(`[radar:${diagnosticId}] Dashboard request failed`, error);
    return NextResponse.json(
      {
        error: "Product Radar data is temporarily unavailable. Try again, or check the server database connection.",
        diagnosticId,
      },
      { status: 500 }
    );
  }
}
