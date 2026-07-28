import { NextRequest, NextResponse } from "next/server";
import { getCustomerDetail } from "@/lib/customers";
import {
  recordCustomerEvent,
  sanitizeLanguage,
  updateCustomerProfile,
} from "@/lib/crm-db";
import { phoneKey } from "@/lib/risk";
import { operatorDataError } from "@/lib/operator-error";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ phoneKey: string }> }
) {
  const { phoneKey: value } = await params;
  try {
    return NextResponse.json(await getCustomerDetail(value));
  } catch (error) {
    console.error("Customer detail load failed", error);
    return NextResponse.json({ error: operatorDataError("customer") }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ phoneKey: string }> }
) {
  const { phoneKey: value } = await params;
  const key = phoneKey(value);
  const body = await req.json();
  const tags: string[] | undefined = Array.isArray(body.tags)
    ? [...new Set<string>(body.tags.map((tag: unknown) => String(tag).trim()).filter(Boolean))].slice(0, 20)
    : undefined;
  try {
    const customer = await updateCustomerProfile(key, {
      ...(typeof body.display_name === "string"
        ? { display_name: body.display_name.trim().slice(0, 120) }
        : {}),
      ...(body.preferred_language !== undefined
        ? {
            preferred_language: sanitizeLanguage(body.preferred_language),
            language_locked:
              sanitizeLanguage(body.preferred_language) !== "auto" &&
              (typeof body.language_locked === "boolean" ? body.language_locked : true),
          }
        : {}),
      ...(tags ? { tags } : {}),
      ...(typeof body.notes === "string" ? { notes: body.notes.trim().slice(0, 5000) } : {}),
      ...(typeof body.ai_enabled === "boolean" ? { ai_enabled: body.ai_enabled } : {}),
      ...(body.ai_paused_until === null || typeof body.ai_paused_until === "string"
        ? { ai_paused_until: body.ai_paused_until }
        : {}),
    });
    await recordCustomerEvent({
      phone_key: key,
      kind: "profile_updated",
      source: "operator",
      payload: { fields: Object.keys(body) },
    });
    return NextResponse.json({ customer });
  } catch (error) {
    console.error("Customer detail update failed", error);
    return NextResponse.json(
      { error: "Customer details could not be saved. Please try again." },
      { status: 500 }
    );
  }
}
