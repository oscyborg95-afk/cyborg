import { NextRequest, NextResponse } from "next/server";
import { archiveOrder, getOrder, updateOrderStatus } from "@/lib/db";
import type { OrderStatus } from "@/lib/types";

const STATUSES: OrderStatus[] = ["pending", "booked", "delivered", "returned"];

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { status } = await req.json();
  if (!STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of ${STATUSES.join(", ")}` },
      { status: 400 }
    );
  }
  const order = await getOrder(id);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  try {
    await updateOrderStatus(id, status);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Update failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const order = await getOrder(id);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  try {
    await archiveOrder(id);
    return NextResponse.json({ ok: true, archived: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Archive failed";
    const conflict = message.includes("cannot be archived");
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 500 });
  }
}
