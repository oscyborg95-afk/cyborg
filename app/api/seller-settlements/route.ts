import { NextRequest, NextResponse } from "next/server";
import { createSellerSettlement, listSellerPayouts } from "@/lib/db";

export async function GET() {
  try {
    return NextResponse.json(await listSellerPayouts());
  } catch (error) {
    console.error("Seller payout load failed", error);
    return NextResponse.json({ error: "Seller payouts could not be loaded" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      sales_account_id?: string;
      paid_at?: string;
      payment_reference?: string;
      notes?: string;
      cash_applied?: boolean;
    };
    const paidAt = new Date(body.paid_at ?? "");
    if (!body.sales_account_id || Number.isNaN(paidAt.getTime())) {
      return NextResponse.json({ error: "sales_account_id and a valid paid_at are required" }, { status: 400 });
    }
    const settlement = await createSellerSettlement({
      sales_account_id: body.sales_account_id,
      paid_at: paidAt.toISOString(),
      payment_reference: String(body.payment_reference ?? "").trim(),
      notes: String(body.notes ?? "").trim(),
      cash_applied: body.cash_applied !== false,
    });
    return NextResponse.json({ settlement }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Seller settlement failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
