import { NextResponse } from "next/server";
import { listCustomerSummaries } from "@/lib/customers";

export async function GET() {
  try {
    return NextResponse.json({ customers: await listCustomerSummaries() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load customers";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
