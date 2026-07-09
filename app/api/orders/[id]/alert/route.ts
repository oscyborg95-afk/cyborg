import { NextRequest, NextResponse } from "next/server";
import { getOrder, getSettings, listManifests, recordCustomerAlert } from "@/lib/db";
import { alertBodyFor, makeTemplates } from "@/lib/templates";
import { phoneToChatId } from "@/lib/phone";
import { sendWhatsAppMessage, WorkerOfflineError } from "@/lib/wa";
import { ALERT_KINDS, type AlertKind } from "@/lib/types";

// Manually (re)send a tracking alert to the customer. Mirrors what the auto
// sweep sends, and records the outcome the same way so the sent/failed status
// on the Orders page stays the single source of truth. Resending an already
// -sent alert is allowed (the UI confirms first) and just refreshes its row.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { kind } = (await req.json()) as { kind?: AlertKind };

  if (!kind || !ALERT_KINDS.includes(kind)) {
    return NextResponse.json(
      { error: `kind must be one of: ${ALERT_KINDS.join(", ")}` },
      { status: 400 }
    );
  }

  const order = await getOrder(id);
  if (!order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }

  const [settings, manifests] = await Promise.all([
    getSettings().catch(() => null),
    listManifests(),
  ]);
  const manifest = manifests.find((m) => m.order_id === id);
  const templates = makeTemplates(settings?.templates ?? {});
  const text = alertBodyFor(templates, kind, manifest?.tracking_id);

  try {
    await sendWhatsAppMessage(phoneToChatId(order.phone_number), text);
    const alert = await recordCustomerAlert(id, kind, text, "sent");
    return NextResponse.json({ alert });
  } catch (err) {
    // Log the miss so the operator sees it failed and can retry.
    await recordCustomerAlert(id, kind, text, "failed").catch(() => {});
    const offline = err instanceof WorkerOfflineError;
    const message = err instanceof Error ? err.message : "Send failed";
    return NextResponse.json({ error: message, offline }, { status: offline ? 503 : 500 });
  }
}
