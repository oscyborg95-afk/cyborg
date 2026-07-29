import { NextResponse } from "next/server";
import { removeLearningConversation } from "@/lib/chat-learning";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ phoneKey: string }> }
) {
  try {
    const { phoneKey } = await context.params;
    const profile = await removeLearningConversation(phoneKey);
    return NextResponse.json({ profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not remove learned chat";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
