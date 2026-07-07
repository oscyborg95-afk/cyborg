import { NextRequest, NextResponse } from "next/server";
import { listAdSpend, upsertAdSpend } from "@/lib/db";

export async function GET() {
  try {
    return NextResponse.json({ spend: await listAdSpend() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load ad spend";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// Upsert one day's ad spend: { day: "YYYY-MM-DD", amount: 1500 }
export async function POST(req: NextRequest) {
  const body = await req.json();
  const day = typeof body.day === "string" ? body.day : "";
  const amount = Number(body.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(amount) || amount < 0) {
    return NextResponse.json(
      { error: "day (YYYY-MM-DD) and a non-negative amount are required" },
      { status: 400 }
    );
  }
  try {
    await upsertAdSpend(day, amount);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save ad spend";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
