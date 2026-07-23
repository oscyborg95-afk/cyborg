import { NextResponse } from "next/server";
import { getAttentionFeed } from "@/lib/attention";

export async function GET() {
  try {
    return NextResponse.json(await getAttentionFeed());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load Attention Center";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
