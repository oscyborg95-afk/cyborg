import { NextRequest, NextResponse } from "next/server";
import { getAgentConfig, updateAgentConfig } from "@/lib/crm-db";
import type { AgentMode } from "@/lib/types";

const MODES: AgentMode[] = ["off", "draft", "auto"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function GET() {
  try {
    return NextResponse.json({ config: await getAgentConfig() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load agent settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const mode = MODES.includes(body.mode as AgentMode) ? (body.mode as AgentMode) : undefined;
  const confidence = Number(body.min_confidence);
  const delay = Number(body.reply_delay_seconds);
  try {
    const config = await updateAgentConfig({
      ...(mode ? { mode } : {}),
      ...(Number.isFinite(confidence)
        ? { min_confidence: Math.min(0.99, Math.max(0.5, confidence)) }
        : {}),
      ...(Number.isFinite(delay)
        ? { reply_delay_seconds: Math.min(30, Math.max(1, Math.round(delay))) }
        : {}),
      ...(typeof body.business_context === "string"
        ? { business_context: body.business_context.trim().slice(0, 8000) }
        : {}),
      ...(typeof body.personality === "string"
        ? { personality: body.personality.trim().slice(0, 2000) }
        : {}),
      ...(TIME_RE.test(body.quiet_hours_start)
        ? { quiet_hours_start: body.quiet_hours_start }
        : {}),
      ...(TIME_RE.test(body.quiet_hours_end)
        ? { quiet_hours_end: body.quiet_hours_end }
        : {}),
    });
    return NextResponse.json({ config });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update agent settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
