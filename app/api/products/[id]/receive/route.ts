import { NextRequest, NextResponse } from "next/server";
import { receiveProductStock } from "@/lib/db";

// Buy new stock: add units at a purchase cost, rolling unit_cost to the new
// weighted average. Body: { quantity, unit_cost }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const quantity = Number(body.quantity);
  const unit_cost = Number(body.unit_cost);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: "quantity must be a positive number" }, { status: 400 });
  }
  if (!Number.isFinite(unit_cost) || unit_cost < 0) {
    return NextResponse.json({ error: "unit_cost must be a non-negative number" }, { status: 400 });
  }

  try {
    const product = await receiveProductStock(id, quantity, unit_cost);
    if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    return NextResponse.json({ product });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to receive stock";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
