import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { receivePurchaseOrder } from "@/lib/replenishment-db";

const schema = z.object({ idempotencyKey: z.string().min(8).max(120), receipts: z.array(z.object({ lineId: z.string().uuid(), quantity: z.number().int().positive(), unitCost: z.number().min(0) })).min(1) });
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { const { id } = await params; const body = schema.parse(await req.json()); return NextResponse.json({ order: await receivePurchaseOrder(id, body.receipts, body.idempotencyKey) }); }
  catch (error) { return NextResponse.json({ error: error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "Receipt failed" }, { status: 400 }); }
}
