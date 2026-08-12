import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { runSalesAgent } from "@/lib/agent-runtime";
import { recordCustomerDeliveryReply } from "@/lib/db";
import { chatIdToPhone } from "@/lib/phone";
import { withTenant } from "@/lib/tenant-context";
import { tenantSchemaForId } from "@/lib/tenants";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const expected = process.env.AGENT_WEBHOOK_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  // Constant-time, matching the courier webhook. A plain === leaks the shared
  // secret one byte at a time to anyone who can measure the response.
  const a = Buffer.from(expected);
  const b = Buffer.from(req.headers.get("x-agent-secret") ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Invalid agent webhook secret" }, { status: 401 });
  }
  const body = await req.json();
  const tenantId = req.headers.get("x-tenant-id") || "";
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
    return NextResponse.json({ error: "Missing tenant context" }, { status: 400 });
  }
  const tenantExists = await tenantSchemaForId(tenantId).then(() => true).catch(() => false);
  if (!tenantExists) return NextResponse.json({ error: "Unknown tenant" }, { status: 404 });
  if (!body?.id || !body?.chatId || body?.fromMe) {
    return NextResponse.json({ skipped: true });
  }
  const session = {
    tenantId,
    userId: "whatsapp-worker",
    role: "member" as const,
    expiresAt: Date.now() + 60_000,
  };
  // An inbound message from someone with a parcel mid-rescue is an answer to
  // the notice we sent them. Record it against the open attempt regardless of
  // what the sales agent decides to do with the message — and never let this
  // bookkeeping fail the turn.
  await withTenant(session, () =>
    recordCustomerDeliveryReply(chatIdToPhone(String(body.chatId)), String(body.body ?? ""))
  ).catch(() => null);
  try {
    const run = await withTenant(session, () => runSalesAgent({
      id: String(body.id),
      chatId: String(body.chatId),
      body: String(body.body ?? ""),
      fromMe: Boolean(body.fromMe),
      timestamp: Number(body.timestamp || Date.now()),
      senderName: String(body.senderName ?? ""),
    }));
    return NextResponse.json({ run, skipped: !run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent turn failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
