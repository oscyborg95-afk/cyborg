import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { sendPurchaseOrder } from "@/lib/replenishment-db";

const schema = z.object({ messageBody: z.string().trim().min(10).max(5000).optional() });
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const { id } = await params; const body = schema.parse(await req.json().catch(() => ({}))); return NextResponse.json({ order: await sendPurchaseOrder(id, body.messageBody) }); }
  catch (error) { return NextResponse.json({ error: error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "Send failed" }, { status: 502 }); }
}
