import { NextRequest, NextResponse } from "next/server";
import { listSalesAccounts, renameSalesAccount } from "@/lib/db";

export async function GET() {
  return NextResponse.json({ accounts: await listSalesAccounts() });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json() as { id?: string; name?: string };
  if (!body.id || !body.name) {
    return NextResponse.json({ error: "id and name are required" }, { status: 400 });
  }
  try {
    const account = await renameSalesAccount(body.id, body.name);
    if (!account) return NextResponse.json({ error: "Sales account not found" }, { status: 404 });
    return NextResponse.json({ account });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Update failed" }, { status: 400 });
  }
}
