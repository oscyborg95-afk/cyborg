import { NextResponse } from "next/server";
import { workerFetch, WorkerOfflineError } from "@/lib/wa";
import type { WaChat } from "@/lib/types";

export async function GET() {
  try {
    const chats = await workerFetch<WaChat[]>("/chats");
    return NextResponse.json({ chats });
  } catch (err) {
    const offline = err instanceof WorkerOfflineError;
    const message = err instanceof Error ? err.message : "Failed to load chats";
    return NextResponse.json({ error: message, offline }, { status: offline ? 503 : 500 });
  }
}
