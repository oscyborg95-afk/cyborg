import { NextResponse } from "next/server";
import { retryAgentRun } from "@/lib/agent-retry";

export async function POST(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  try {
    return NextResponse.json({ run: await retryAgentRun(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not retry agent run";
    const conflict =
      message.includes("Only failed") ||
      message.includes("superseded") ||
      message.includes("no longer available");
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }
}
