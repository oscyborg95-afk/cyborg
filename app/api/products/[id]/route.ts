import { NextRequest, NextResponse } from "next/server";
import { deleteProduct, updateProduct } from "@/lib/db";
import type { NewProduct } from "@/lib/types";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  const patch: Partial<NewProduct> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    patch.name = name;
  }
  for (const field of ["price", "unit_cost", "stock_units"] as const) {
    if (body[field] !== undefined) {
      const value = Number(body[field]);
      if (Number.isNaN(value)) {
        return NextResponse.json({ error: `${field} must be a number` }, { status: 400 });
      }
      patch[field] = value;
    }
  }

  try {
    const product = await updateProduct(id, patch);
    if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    return NextResponse.json({ product });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await deleteProduct(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
