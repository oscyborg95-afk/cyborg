import { NextResponse } from "next/server";
import {
  workerFetch,
  WorkerOfflineError,
  WorkerTimeoutError,
} from "@/lib/wa";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await workerFetch<{ ok: boolean }>("/logout", { method: "POST" });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const unavailable =
      err instanceof WorkerOfflineError || err instanceof WorkerTimeoutError;
    const message =
      err instanceof Error ? err.message : "Could not switch WhatsApp accounts.";
    return NextResponse.json(
      { error: message },
      { status: unavailable ? 503 : 500 }
    );
  }
}
