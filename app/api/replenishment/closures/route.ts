import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { deleteClosure, listClosures, saveClosure } from "@/lib/replenishment-db";

const schema = z.object({ id: z.string().uuid().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().trim().min(2).max(120), supplier_id: z.string().uuid().nullable().optional() });
export async function GET() { return NextResponse.json({ closures: await listClosures() }); }
export async function POST(req: NextRequest) {
  try { return NextResponse.json({ closure: await saveClosure(schema.parse(await req.json())) }); }
  catch (error) { return NextResponse.json({ error: error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "Invalid closure" }, { status: 400 }); }
}
export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id"); if (!id || !z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Valid closure id required" }, { status: 400 });
  await deleteClosure(id); return NextResponse.json({ ok: true });
}
