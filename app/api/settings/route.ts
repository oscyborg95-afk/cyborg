import { NextRequest, NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db";

export async function GET() {
  try {
    return NextResponse.json({ settings: await getSettings() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const settings = {
    bank_cash: Number(body.bank_cash ?? 0),
    stock_units: Number(body.stock_units ?? 0),
    stock_unit_cost: Number(body.stock_unit_cost ?? 155.83),
    business_name: String(body.business_name ?? ""),
    business_address: String(body.business_address ?? ""),
    business_phone_1: String(body.business_phone_1 ?? ""),
    business_phone_2: String(body.business_phone_2 ?? ""),
  };
  if ([settings.bank_cash, settings.stock_units, settings.stock_unit_cost].some(Number.isNaN)) {
    return NextResponse.json({ error: "All settings must be numbers" }, { status: 400 });
  }
  try {
    return NextResponse.json({ settings: await updateSettings(settings) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
