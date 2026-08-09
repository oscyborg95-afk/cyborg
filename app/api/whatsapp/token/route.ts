import { NextResponse } from "next/server";
import { mintWorkerAccessToken } from "@/lib/worker-token";

export const dynamic = "force-dynamic";

// proxy.ts authenticates this route before it can mint browser credentials.
export async function GET() {
  return NextResponse.json(await mintWorkerAccessToken());
}
