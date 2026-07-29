import { NextResponse } from "next/server";
import {
  workerFetch,
  WorkerOfflineError,
  WorkerResponseError,
  WorkerTimeoutError,
} from "@/lib/wa";
import type { WaChat } from "@/lib/types";

export async function GET() {
  try {
    const chats = await workerFetch<WaChat[]>("/chats");
    return NextResponse.json({ chats });
  } catch (err) {
    // An unlinked worker has no chats yet; that is a valid empty inbox, not a
    // server failure. Connection status and the QR are served separately.
    if (err instanceof WorkerResponseError && err.status === 503) {
      return NextResponse.json({ chats: [] });
    }
    const offline =
      err instanceof WorkerOfflineError || err instanceof WorkerTimeoutError;
    const message = err instanceof Error ? err.message : "Failed to load chats";
    const status =
      err instanceof WorkerResponseError ? err.status : offline ? 503 : 500;
    return NextResponse.json({ error: message, offline }, { status });
  }
}
