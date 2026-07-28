import { NextResponse } from "next/server";
import { getAttentionFeed } from "@/lib/attention";
import { operatorDataError } from "@/lib/operator-error";

export async function GET() {
  try {
    return NextResponse.json(await getAttentionFeed());
  } catch (error) {
    console.error("Action Queue load failed", error);
    return NextResponse.json({ error: operatorDataError("actions") }, { status: 500 });
  }
}
