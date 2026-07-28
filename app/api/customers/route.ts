import { NextResponse } from "next/server";
import { listCustomerSummaries } from "@/lib/customers";
import { operatorDataError } from "@/lib/operator-error";

export async function GET() {
  try {
    return NextResponse.json({ customers: await listCustomerSummaries() });
  } catch (error) {
    console.error("Customer directory load failed", error);
    return NextResponse.json({ error: operatorDataError("customers") }, { status: 500 });
  }
}
