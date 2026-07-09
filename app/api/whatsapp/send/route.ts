import { NextRequest, NextResponse } from "next/server";
import { sendWhatsAppMessage, WorkerOfflineError } from "@/lib/wa";

export async function POST(req: NextRequest) {
  const { chatId, text, media } = await req.json();
  if (!chatId || (!text && !media?.data)) {
    return NextResponse.json({ error: "chatId and text (or media) are required" }, { status: 400 });
  }
  try {
    await sendWhatsAppMessage(chatId, text ?? "", media);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const offline = err instanceof WorkerOfflineError;
    const message = err instanceof Error ? err.message : "Send failed";
    return NextResponse.json({ error: message, offline }, { status: offline ? 503 : 500 });
  }
}
