import { NextRequest, NextResponse } from "next/server";
import { getCustomerDetail } from "@/lib/customers";
import {
  recordCustomerEvent,
  sanitizeLanguage,
  updateCustomerProfile,
} from "@/lib/crm-db";
import { phoneKey } from "@/lib/risk";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ phoneKey: string }> }
) {
  const { phoneKey: value } = await params;
  try {
    return NextResponse.json(await getCustomerDetail(value));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load customer";
    return NextResponse.json({ error: message }, { status: 500 });
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
        ? { preferred_language: sanitizeLanguage(body.preferred_language) }
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
    const message = error instanceof Error ? error.message : "Failed to update customer";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
