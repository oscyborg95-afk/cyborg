import { NextRequest, NextResponse } from "next/server";
import { runSalesAgent } from "@/lib/agent-runtime";

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
  if (!body?.id || !body?.chatId || body?.fromMe) {
    return NextResponse.json({ skipped: true });
  }
  try {
    const run = await runSalesAgent({
      id: String(body.id),
      chatId: String(body.chatId),
      body: String(body.body ?? ""),
      fromMe: Boolean(body.fromMe),
      timestamp: Number(body.timestamp || Date.now()),
      senderName: String(body.senderName ?? ""),
    });
    return NextResponse.json({ run, skipped: !run });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent turn failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
