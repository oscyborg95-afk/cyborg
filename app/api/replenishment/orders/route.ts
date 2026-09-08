import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { createPurchaseOrder, listPurchaseOrders } from "@/lib/replenishment-db";

const schema = z.object({ supplierId: z.string().uuid(), lines: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(100000) })).min(1).max(100), messageBody: z.string().max(5000).optional() });
export async function GET() { return NextResponse.json({ orders: await listPurchaseOrders() }); }
export async function POST(req: NextRequest) {
  try { const result = await createPurchaseOrder(schema.parse(await req.json())); return NextResponse.json(result, { status: result.reused ? 200 : 201 }); }
  catch (error) { return NextResponse.json({ error: error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "Could not create request" }, { status: 400 }); }
}
