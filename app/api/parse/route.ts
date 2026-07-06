import { NextRequest, NextResponse } from "next/server";
import { parseRawAddress } from "@/lib/parse";
import { shippingFeeFor } from "@/lib/districts";

export async function POST(req: NextRequest) {
  const { raw_text } = await req.json();
  if (!raw_text || typeof raw_text !== "string" || !raw_text.trim()) {
    return NextResponse.json({ error: "raw_text is required" }, { status: 400 });
  }

  try {
    const parsed = await parseRawAddress(raw_text);
    return NextResponse.json({
      ...parsed,
      shipping_fee: shippingFeeFor(parsed.district),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Parsing failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
