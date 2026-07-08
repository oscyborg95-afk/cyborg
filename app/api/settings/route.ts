import { NextRequest, NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/db";
import { DEFAULT_TEMPLATES } from "@/lib/templates";
import type { MessageTemplates, TemplateKey } from "@/lib/types";

// Keep only known template keys with non-empty string values; an override
// identical to the default is dropped so the row stays minimal.
function sanitizeTemplates(raw: unknown): MessageTemplates {
  const out: MessageTemplates = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const key of Object.keys(DEFAULT_TEMPLATES) as TemplateKey[]) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim() && v !== DEFAULT_TEMPLATES[key]) {
      out[key] = v;
    }
  }
  return out;
}

// Short, tidy order-number prefix: letters/digits/dash only, upper-cased,
// capped at 6 chars, with a sensible default so the reference is never bare.
function sanitizePrefix(raw: unknown): string {
  const cleaned = String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .replace(/-+$/, "")
    .slice(0, 6);
  return cleaned || "DC";
}

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
    order_prefix: sanitizePrefix(body.order_prefix),
    templates: sanitizeTemplates(body.templates),
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
