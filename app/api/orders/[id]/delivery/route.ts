import { NextRequest, NextResponse } from "next/server";
import {
  cancelPendingAttemptReminders,
  enqueueDeliveryNotification,
  getDeliveryAttempt,
  getSettings,
  updateDeliveryAttempt,
} from "@/lib/db";
import { ownerCallDueAt, scheduledMorningAt } from "@/lib/delivery-events";
import { phoneToChatId } from "@/lib/phone";
import type { DeliveryCallStatus } from "@/lib/types";

const ACTION_STATUS: Record<string, DeliveryCallStatus> = {
  confirmed: "called_confirmed",
  no_answer: "called_no_answer",
  date_change: "date_change_requested",
  reopen: "pending",
  resolve: "resolved",
};

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: orderId } = await params;
  const body = await request.json() as {
    attempt_id?: string;
    action?: string;
    next_delivery_date?: string | null;
    notes?: string;
  };
  if (!body.attempt_id) {
    return NextResponse.json({ error: "attempt_id is required" }, { status: 400 });
  }
  const attempt = await getDeliveryAttempt(body.attempt_id);
  if (!attempt || attempt.order_id !== orderId) {
    return NextResponse.json({ error: "Delivery attempt not found" }, { status: 404 });
  }
  if (body.action && !ACTION_STATUS[body.action]) {
    return NextResponse.json({ error: "Invalid call action" }, { status: 400 });
  }
  if (
    body.next_delivery_date !== undefined &&
    body.next_delivery_date !== null &&
    !validDate(body.next_delivery_date)
  ) {
    return NextResponse.json({ error: "next_delivery_date must be YYYY-MM-DD" }, { status: 400 });
  }

  const nextDate = body.next_delivery_date !== undefined
    ? body.next_delivery_date
    : attempt.next_delivery_date;
  const callDueAt = body.next_delivery_date !== undefined
    ? ownerCallDueAt(nextDate, attempt.last_event_at)
    : undefined;
  const updated = await updateDeliveryAttempt({
    id: attempt.id,
    call_status: body.action ? ACTION_STATUS[body.action] : undefined,
    next_delivery_date: body.next_delivery_date,
    call_due_at: callDueAt,
    call_notes: typeof body.notes === "string" ? body.notes.slice(0, 1000) : undefined,
  });
  if (!updated) {
    return NextResponse.json({ error: "Delivery attempt not found" }, { status: 404 });
  }

  if (body.next_delivery_date !== undefined) {
    await cancelPendingAttemptReminders(attempt.id);
  }
  if (body.next_delivery_date !== undefined && nextDate) {
    const settings = await getSettings();
    const ownerPhone = settings.business_phone_1.trim();
    if (ownerPhone) {
      const ownerChat = phoneToChatId(ownerPhone);
      const prefix = `delivery:${orderId}:attempt:${attempt.attempt_no}:manual:${nextDate}`;
      const reminder = [
        "📞 CALL REMINDER",
        `Tracking: ${attempt.tracking_id}`,
        `Next attempt: ${attempt.attempt_no + 1}`,
        `Delivery date: ${nextDate}`,
        "Please confirm the customer will answer the courier.",
      ].join("\n");
      if (callDueAt) {
        await enqueueDeliveryNotification({
          order_id: orderId,
          delivery_attempt_id: attempt.id,
          recipient: "owner",
          chat_id: ownerChat,
          body: reminder,
          notification_type: "owner_call_reminder",
          dedupe_key: `${prefix}:owner_call_reminder`,
          next_attempt_at: callDueAt,
        });
      }
      const morningAt = scheduledMorningAt(nextDate);
      if (morningAt && new Date(morningAt).getTime() > Date.now()) {
        await enqueueDeliveryNotification({
          order_id: orderId,
          delivery_attempt_id: attempt.id,
          recipient: "owner",
          chat_id: ownerChat,
          body: `🚨 DELIVERY TODAY — CALL STILL OPEN\nTracking: ${attempt.tracking_id}\nAttempt: ${attempt.attempt_no + 1}\nPlease contact the customer now.`,
          notification_type: "owner_morning_reminder",
          dedupe_key: `${prefix}:owner_morning_reminder`,
          next_attempt_at: morningAt,
        });
      }
    }
  }

  return NextResponse.json({ attempt: updated });
}
