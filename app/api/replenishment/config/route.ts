import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { listProductConfigs, saveProductConfig } from "@/lib/replenishment-db";

const schema = z.object({ product_id: z.string().uuid(), supplier_id: z.string().uuid(), moq: z.number().int().min(1).max(100000), pack_size: z.number().int().min(1).max(100000), supplier_sku: z.string().trim().max(80).default(""), unit_cost: z.number().min(0).nullable().default(null), preferred: z.boolean().default(true), target_cover_days: z.number().int().min(1).max(90).default(14) });
export async function GET() { return NextResponse.json({ configs: await listProductConfigs() }); }
export async function POST(req: NextRequest) {
  try { return NextResponse.json({ config: await saveProductConfig(schema.parse(await req.json())) }); }
  catch (error) { return NextResponse.json({ error: error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "Invalid settings" }, { status: 400 }); }
}
