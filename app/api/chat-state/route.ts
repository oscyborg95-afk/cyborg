import { NextRequest, NextResponse } from "next/server";
import { listChatStates, upsertChatState } from "@/lib/db";
import { CHAT_STATES, type ChatStateValue } from "@/lib/types";

export async function GET() {
  try {
    const states = await listChatStates();
    return NextResponse.json({ states });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load chat states";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { phone_number, chat_id, state, display_name } = await req.json();
  if (!phone_number || !chat_id || !CHAT_STATES.includes(state as ChatStateValue)) {
    return NextResponse.json(
      { error: `phone_number, chat_id and a valid state (${CHAT_STATES.join(", ")}) are required` },
      { status: 400 }
    );
  }
  try {
    const record = await upsertChatState(phone_number, chat_id, state, display_name);
    return NextResponse.json({ state: record });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save chat state";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
