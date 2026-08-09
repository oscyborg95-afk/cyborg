import { NextRequest, NextResponse } from "next/server";
import { runSalesAgent } from "@/lib/agent-runtime";
import { withTenant } from "@/lib/tenant-context";
import { tenantSchemaForId } from "@/lib/tenants";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const expected = process.env.AGENT_WEBHOOK_SECRET;
  if (!expected) return process.env.NODE_ENV !== "production";
  return req.headers.get("x-agent-secret") === expected;
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
  try {
    const run = await withTenant({ tenantId, userId: "whatsapp-worker", role: "member", expiresAt: Date.now() + 60_000 }, () => runSalesAgent({
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
