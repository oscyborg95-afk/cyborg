import { NextRequest, NextResponse } from "next/server";
import {
  approveLearningCandidates,
  getSalesStyleProfile,
  listLearningCandidates,
  listLearningConversations,
} from "@/lib/chat-learning";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    const [candidates, conversations, profile] = await Promise.all([
      listLearningCandidates(),
      listLearningConversations(),
      getSalesStyleProfile(),
    ]);
    return NextResponse.json({ candidates, conversations, profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load chat learning";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const phoneKeys = Array.isArray(body.phone_keys)
      ? body.phone_keys.filter((value: unknown): value is string => typeof value === "string")
      : [];
    if (phoneKeys.length === 0) {
      return NextResponse.json({ error: "Select at least one delivered-order chat" }, { status: 400 });
    }
    const result = await approveLearningCandidates(phoneKeys.slice(0, 100));
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not approve chats";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
