import { NextRequest, NextResponse } from "next/server";
import {
  cancelPendingAttemptReminders,
  getDeliveryAttempt,
  updateDeliveryAttempt,
} from "@/lib/db";
import { ownerCallDueAt } from "@/lib/delivery-events";
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
  // Setting a date by hand used to queue this attempt its own call reminder and
  // its own delivery-morning nudge. Both are now covered by the owner's daily
  // digest, which reads next_delivery_date straight off the attempt — so the
  // manual date shows up there with no per-parcel message of its own.

  return NextResponse.json({ attempt: updated });
}
