import { NextRequest, NextResponse } from "next/server";
import { sendWhatsAppMessage, WorkerOfflineError } from "@/lib/wa";
import { ensureCustomerProfile, recordCustomerEvent } from "@/lib/crm-db";
import { chatIdToPhone } from "@/lib/phone";
import { phoneKey } from "@/lib/risk";

export async function POST(req: NextRequest) {
  const { chatId, text, media } = await req.json();
  if (!chatId || (!text && !media?.data)) {
    return NextResponse.json({ error: "chatId and text (or media) are required" }, { status: 400 });
  }
  try {
    await sendWhatsAppMessage(chatId, text ?? "", media);
    const phone = chatIdToPhone(chatId);
    const key = phoneKey(phone);
    if (key.length >= 9) {
      await ensureCustomerProfile({
        phone_key: key,
        primary_phone: phone,
        direction: "outbound",
      }).catch(() => {});
      await recordCustomerEvent({
        phone_key: key,
        chat_id: chatId,
        kind: "message_out",
        source: "operator",
        payload: { body: String(text ?? "").slice(0, 1000), has_media: Boolean(media?.data) },
      }).catch(() => {});
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const offline = err instanceof WorkerOfflineError;
    const message = err instanceof Error ? err.message : "Send failed";
    return NextResponse.json({ error: message, offline }, { status: offline ? 503 : 500 });
  }
}
