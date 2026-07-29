import { NextResponse } from "next/server";
import {
  workerFetch,
  WorkerOfflineError,
  WorkerTimeoutError,
} from "@/lib/wa";

export const dynamic = "force-dynamic";

type WhatsAppStatus = {
  ready: boolean;
  qr: string | null;
};

export async function GET() {
  try {
    const status = await workerFetch<WhatsAppStatus>("/qr.json");
    return NextResponse.json(status);
  } catch (err) {
    const unavailable =
      err instanceof WorkerOfflineError || err instanceof WorkerTimeoutError;
    const message =
      err instanceof Error ? err.message : "Failed to load WhatsApp status";

    return NextResponse.json(
      { error: message, offline: unavailable },
      { status: unavailable ? 503 : 500 }
    );
  }
}
