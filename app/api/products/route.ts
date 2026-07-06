import { NextRequest, NextResponse } from "next/server";
import { createProduct, listProducts } from "@/lib/db";

export async function GET() {
  try {
    return NextResponse.json({ products: await listProducts() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load products";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const name = String(body.name ?? "").trim();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const price = Number(body.price ?? 0);
  const unit_cost = Number(body.unit_cost ?? 0);
  const stock_units = Number(body.stock_units ?? 0);
  if ([price, unit_cost, stock_units].some(Number.isNaN)) {
    return NextResponse.json({ error: "price, unit_cost and stock_units must be numbers" }, { status: 400 });
  }
  try {
    const product = await createProduct({ name, price, unit_cost, stock_units });
    return NextResponse.json({ product }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create product";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
