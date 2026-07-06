import { NextRequest, NextResponse } from "next/server";
import { workerFetch, WorkerOfflineError } from "@/lib/wa";
import type { WaMessage } from "@/lib/types";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params;
  try {
    const messages = await workerFetch<WaMessage[]>(
      `/messages/${encodeURIComponent(chatId)}`
    );
    return NextResponse.json({ messages });
  } catch (err) {
    const offline = err instanceof WorkerOfflineError;
    const message = err instanceof Error ? err.message : "Failed to load messages";
    return NextResponse.json({ error: message, offline }, { status: offline ? 503 : 500 });
  }
}
