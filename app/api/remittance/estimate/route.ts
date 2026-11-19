import { NextResponse } from "next/server";
import { getPayoutEstimateData, getSettings } from "@/lib/db";
import { estimatePayout } from "@/lib/payout-estimate";
import { operatorDataError } from "@/lib/operator-error";

export const runtime = "nodejs";

// What the courier should actually deposit for delivered, unsettled parcels,
// split into the next weekly invoice and the one after.
export async function GET() {
  try {
    const [data, settings] = await Promise.all([getPayoutEstimateData(), getSettings()]);
    return NextResponse.json({
      estimate: estimatePayout({
        ...data,
        settings_base_charge: Number(settings.courier_cost_base) || 0,
        district_overrides: settings.courier_cost_overrides ?? {},
      }),
    });
  } catch (err) {
    console.error("Courier payout estimate failed", err);
    return NextResponse.json({ error: operatorDataError("payouts") }, { status: 500 });
  }
}
