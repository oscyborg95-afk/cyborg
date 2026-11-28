import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { handleFollowUpInbound } from "@/lib/followups";
import { withTenant } from "@/lib/tenant-context";
import { tenantSchemaForId } from "@/lib/tenants";
import { handleWelcomeInbound } from "@/lib/welcome";
import { validPhoneChatId } from "@/lib/welcome-policy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Called by the WhatsApp worker (worker/index.js) once a customer's burst of
// new messages settles. A reply ends any follow-up sequence chasing that
// customer ("stop" opts them out for good), and a brand-new customer gets the
// automatic welcome. Authenticated with the worker's CRON_SECRET, compared in
// constant time like the courier webhook.
function authorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const a = Buffer.from(`Bearer ${expected}`);
  const b = Buffer.from(req.headers.get("authorization") ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tenantId = req.headers.get("x-tenant-id") || "";
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
    return NextResponse.json({ error: "Missing tenant context" }, { status: 400 });
  }
  const tenantExists = await tenantSchemaForId(tenantId).then(() => true).catch(() => false);
  if (!tenantExists) return NextResponse.json({ error: "Unknown tenant" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const chatId = typeof body?.chatId === "string" ? body.chatId : "";
  const timestamp = Number(body?.timestamp);
  const text = typeof body?.body === "string" ? body.body.slice(0, 2_000) : "";
  // For a privacy-ID (@lid) chat, the same person's phone chat (from the worker).
  const phoneChatId = validPhoneChatId(body?.phoneChatId);
  if (!chatId || body?.fromMe) return NextResponse.json({ skipped: "not_inbound" });

  const session = {
    tenantId,
    userId: "whatsapp-worker",
    role: "member" as const,
    expiresAt: Date.now() + 120_000,
  };
  // Runs first and on its own: chasing someone who already answered (or said
  // stop) is exactly what gets a number reported, so this must not wait on,
  // or fail with, the welcome.
  // Follow-ups are filed under the phone number, so use it when we have it.
  const followUps = await withTenant(session, () => handleFollowUpInbound(phoneChatId ?? chatId, text))
    .then(() => "checked")
    .catch((error) => (error instanceof Error ? error.message : "failed"));
  try {
    const welcome = await withTenant(session, () => handleWelcomeInbound({ chatId, timestamp, phoneChatId }));
    return NextResponse.json({ ok: true, followUps, welcome });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Inbound handling failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
