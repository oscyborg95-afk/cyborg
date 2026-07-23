import { NextRequest, NextResponse } from "next/server";
import { updateAttention } from "@/lib/crm-db";
import type { AttentionStatus } from "@/lib/types";

const STATUSES: AttentionStatus[] = ["open", "snoozed", "resolved"];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  if (!STATUSES.includes(body.status as AttentionStatus)) {
    return NextResponse.json({ error: "A valid status is required" }, { status: 400 });
  }
  const snoozedUntil =
    body.status === "snoozed" && typeof body.snoozed_until === "string"
      ? body.snoozed_until
      : null;
  try {
    const item = await updateAttention(id, body.status, snoozedUntil);
    if (!item) return NextResponse.json({ error: "Attention item not found" }, { status: 404 });
    return NextResponse.json({ item });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update attention item";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
