import { NextRequest, NextResponse } from "next/server";
import { cancelSalesAgentRuns } from "@/lib/agent-runtime";
import { purgeCustomerData } from "@/lib/crm-db";
import { deleteChatState } from "@/lib/db";
import { chatIdToPhone } from "@/lib/phone";
import { phoneKey } from "@/lib/risk";
import { workerFetch, WorkerOfflineError } from "@/lib/wa";
import type { WaMessage } from "@/lib/types";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params;
  try {
    const messages = await workerFetch<WaMessage[]>(
      `/messages/${encodeURIComponent(chatId)}`
    );
    return NextResponse.json({ messages });
  } catch (err) {
    const offline = err instanceof WorkerOfflineError;
    const message = err instanceof Error ? err.message : "Failed to load messages";
    return NextResponse.json({ error: message, offline }, { status: offline ? 503 : 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
) {
  const { chatId } = await params;
  if (
    !chatId ||
    chatId.endsWith("@g.us") ||
    chatId.endsWith("@newsletter") ||
    chatId === "status@broadcast"
  ) {
    return NextResponse.json(
      { error: "Only direct customer chats can be deleted" },
      { status: 400 }
    );
  }

  const phone = chatIdToPhone(chatId);
  const key = phoneKey(phone);
  if (key.length !== 9) {
    return NextResponse.json({ error: "Chat has no valid customer phone number" }, { status: 400 });
  }

  try {
    await cancelSalesAgentRuns(chatId);
    const [customerData, chatStates] = await Promise.all([
      purgeCustomerData(key, chatId),
      deleteChatState(phone, chatId),
    ]);
    const worker = await workerFetch<{
      ok: boolean;
      deleted: { chats: number; messages: number; media: number };
    }>(`/chats/${encodeURIComponent(chatId)}`, { method: "DELETE" });
    return NextResponse.json({
      ok: true,
      deleted: { ...customerData, chatStates, ...worker.deleted },
      preserved: ["orders", "invoices", "courier records", "financial history"],
    });
  } catch (error) {
    const offline = error instanceof WorkerOfflineError;
    const message = error instanceof Error ? error.message : "Failed to delete chat data";
    return NextResponse.json({ error: message, offline }, { status: offline ? 503 : 500 });
  }
}
