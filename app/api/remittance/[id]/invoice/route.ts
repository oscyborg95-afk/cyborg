import { NextRequest, NextResponse } from "next/server";
import { getCourierRemittanceFile } from "@/lib/db";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const file = await getCourierRemittanceFile(id);
  if (!file) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  const safeName = file.filename.replace(/[\r\n"\\/]/g, "_");
  return new NextResponse(new Uint8Array(file.data), {
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
