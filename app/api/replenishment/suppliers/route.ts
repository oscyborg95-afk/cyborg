import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { deleteSupplier, listSuppliers, saveSupplier } from "@/lib/replenishment-db";

const schema = z.object({
  id: z.string().uuid().optional(), name: z.string().trim().min(2).max(120),
  whatsapp_phone: z.string().trim().min(9).max(24), lead_time_working_days: z.number().int().min(1).max(30).default(1),
  working_weekdays: z.array(z.number().int().min(0).max(6)).min(1).default([1, 2, 3, 4, 5, 6]),
  active: z.boolean().default(true), automatic_send: z.boolean().default(false),
});

function normalizeSriLankanPhone(value: string): string {
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("0094")) digits = digits.slice(2);
  if (digits.startsWith("94") && digits.length === 11) return `0${digits.slice(2)}`;
  if (digits.length === 9) return `0${digits}`;
  if (/^0\d{9}$/.test(digits)) return digits;
  throw new Error("Enter a valid Sri Lankan WhatsApp number");
}

export async function GET() { return NextResponse.json({ suppliers: await listSuppliers() }); }
export async function POST(req: NextRequest) {
  try {
    const data = schema.parse(await req.json());
    return NextResponse.json({ supplier: await saveSupplier({ ...data, whatsapp_phone: normalizeSriLankanPhone(data.whatsapp_phone) }) }, { status: data.id ? 200 : 201 });
  } catch (error) {
    const message = error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "Invalid supplier";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id || !z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Valid supplier id required" }, { status: 400 });
  try { await deleteSupplier(id); return NextResponse.json({ ok: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Delete failed" }, { status: 409 }); }
}
