import {
  getSettings,
  getTrackedOrderByWaybill,
  hasSentAlert,
  ingestDeliveryEvent,
  type DeliveryNotificationInput,
} from "./db.ts";
import {
  ownerCallDueAt,
  scheduledMorningAt,
  type NormalizedDeliveryEvent,
} from "./delivery-events.ts";
import { phoneToChatId } from "./phone.ts";
import { makeTemplates } from "./templates.ts";
import type { Order } from "./types.ts";

function displayDate(value: string | null): string {
  if (!value) return "date not confirmed";
  return new Intl.DateTimeFormat("en-LK", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Colombo",
  }).format(new Date(`${value}T12:00:00+05:30`));
}

function cleanReason(reason: string): string {
  return reason
    .replace(
      /\s*(?:re-?schedule(?:d)?|next\s*delivery|re-?delivery|delivery)\s*(?:date|on|to|for)?\s*[:\-=]?\s*\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\s*/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function isReschedule(status: NormalizedDeliveryEvent["status"]): boolean {
  return status === "rescheduled" || status === "branch_rescheduled";
}

function ownerAlertBody(
  order: Order,
  event: NormalizedDeliveryEvent
): string {
  const urgency = event.attemptNo >= 3
    ? "🚨 FINAL ATTEMPT RISK"
    : event.attemptNo === 2
      ? "⚠️ SECOND ATTEMPT"
      : "⚠️ DELIVERY RESCHEDULED";
  return [
    urgency,
    `Order: ${order.order_no ?? order.id}`,
    `Customer: ${order.customer_name}`,
    `Phone: ${order.phone_number}`,
    order.phone_2 ? `Phone 2: ${order.phone_2}` : "",
    `Tracking: ${event.trackingId}`,
    `Attempt: ${event.attemptNo}`,
    `Next delivery: ${displayDate(event.nextDeliveryDate)}`,
    cleanReason(event.reason) ? `Courier note: ${cleanReason(event.reason)}` : "",
    "",
    event.nextDeliveryDate
      ? "Please call the customer and confirm they will answer the courier."
      : "Please call now and set/confirm the next delivery date.",
  ].filter(Boolean).join("\n");
}

function ownerReminderBody(event: NormalizedDeliveryEvent, morning = false): string {
  return [
    morning ? "🚨 DELIVERY TODAY — CALL STILL OPEN" : "📞 CALL REMINDER",
    `Tracking: ${event.trackingId}`,
    `Attempt: ${event.attemptNo + 1}`,
    `Delivery: ${displayDate(event.nextDeliveryDate)}`,
    event.attemptNo >= 2 ? "High return risk — please contact this customer now." : "Please confirm the customer will answer the courier.",
  ].join("\n");
}

function customerRescheduleBody(
  base: string,
  event: NormalizedDeliveryEvent
): string {
  const details = [
    `📅 Next delivery: ${displayDate(event.nextDeliveryDate)}`,
    event.attemptNo >= 2 ? `⚠️ Delivery attempt ${event.attemptNo + 1} will be the next attempt.` : "",
  ].filter(Boolean);
  return [base, ...details].join("\n");
}

export async function processDeliveryEvent(
  event: NormalizedDeliveryEvent,
  source: "webhook" | "poll" = "poll",
  sendNotifications = true
) {
  const [tracked, settings] = await Promise.all([
    getTrackedOrderByWaybill(event.trackingId),
    getSettings(),
  ]);
  if (!tracked) throw new Error(`Unknown waybill ${event.trackingId}`);
  const templates = makeTemplates(settings.templates, settings.business_name);
  const notifications: DeliveryNotificationInput[] = [];
  const customerChat = phoneToChatId(tracked.order.phone_number);
  const ownerPhone = settings.business_phone_1.trim();
  const ownerChat = ownerPhone ? phoneToChatId(ownerPhone) : "";
  const prefix = `delivery:${tracked.order.id}:attempt:${event.attemptNo}`;
  // Owner alerts stay per-date: a new delivery date is genuinely new information
  // worth a second alert. Where the courier gave no date they collapse onto one
  // key per attempt, as before.
  const exceptionPrefix =
    isReschedule(event.status) && event.nextDeliveryDate
      ? `delivery:${tracked.order.id}:reschedule:${event.nextDeliveryDate}`
      : prefix;
  // The customer-facing key deliberately carries no attempt number. The webhook
  // reads the attempt from a payload field while the poller re-derives it from
  // history on every run, so the two disagree constantly and a key built from
  // either one lets the same reschedule through twice. Order + date is stable
  // across both paths, and the queue's per-order cooldown catches the rest.
  const customerRescheduleKey =
    `delivery:${tracked.order.id}:customer_rescheduled:${event.nextDeliveryDate ?? "pending"}`;
  const now = new Date();
  const callDueAt = isReschedule(event.status)
    ? ownerCallDueAt(event.nextDeliveryDate, event.occurredAt, now)
    : null;

  const legacyAlreadySent =
    event.status === "out_for_delivery" && event.attemptNo === 1
      ? await hasSentAlert(tracked.order.id, "out_for_delivery")
      : event.status === "delivered"
        ? await hasSentAlert(tracked.order.id, "delivered")
        : event.status === "returned_to_ho"
          ? await hasSentAlert(tracked.order.id, "returned")
          : false;

  if (event.status === "out_for_delivery" && !legacyAlreadySent) {
    notifications.push({
      recipient: "customer",
      chat_id: customerChat,
      body: templates.outForDelivery(event.trackingId),
      notification_type: "customer_out_for_delivery",
      dedupe_key: `${prefix}:customer_out_for_delivery`,
    });
    if (ownerChat && event.attemptNo > 1) {
      notifications.push({
        recipient: "owner",
        chat_id: ownerChat,
        body: ownerReminderBody(event, true),
        notification_type: "owner_morning_reminder",
        dedupe_key: `${prefix}:owner_morning_reminder`,
      });
    }
  }

  if (isReschedule(event.status)) {
    // A parcel that went back to the branch is an internal courier movement;
    // the customer hears about it only once it is rescheduled for real.
    if (event.status === "rescheduled") {
      notifications.push({
        recipient: "customer",
        chat_id: customerChat,
        body: customerRescheduleBody(
          templates.rescheduledDelivery(event.trackingId),
          event
        ),
        notification_type: "customer_rescheduled",
        dedupe_key: customerRescheduleKey,
      });
    }
    if (ownerChat) {
      notifications.push({
        recipient: "owner",
        chat_id: ownerChat,
        body: ownerAlertBody(tracked.order, event),
        notification_type: "owner_reschedule_alert",
        dedupe_key: `${exceptionPrefix}:owner_reschedule_alert`,
      });
      if (callDueAt && new Date(callDueAt).getTime() > now.getTime() + 60_000) {
        notifications.push({
          recipient: "owner",
          chat_id: ownerChat,
          body: ownerReminderBody(event),
          notification_type: "owner_call_reminder",
          dedupe_key: `${exceptionPrefix}:owner_call_reminder`,
          next_attempt_at: callDueAt,
        });
      }
      const morningAt = scheduledMorningAt(event.nextDeliveryDate);
      if (morningAt && new Date(morningAt).getTime() > now.getTime()) {
        notifications.push({
          recipient: "owner",
          chat_id: ownerChat,
          body: ownerReminderBody(event, true),
          notification_type: "owner_morning_reminder",
          dedupe_key: `${exceptionPrefix}:owner_morning_reminder`,
          next_attempt_at: morningAt,
        });
      }
    }
  }

  if ((event.status === "failed_to_deliver" || event.status === "branch_failed") && ownerChat) {
    notifications.push({
      recipient: "owner",
      chat_id: ownerChat,
      body: ownerAlertBody(tracked.order, event),
      notification_type: "owner_delivery_failed",
      dedupe_key: `${prefix}:owner_delivery_failed`,
    });
  }

  if (event.status === "delivered" && !legacyAlreadySent) {
    notifications.push({
      recipient: "customer",
      chat_id: customerChat,
      body: templates.deliveredThanks(),
      notification_type: "customer_delivered",
      dedupe_key: `delivery:${tracked.order.id}:customer_delivered`,
    });
  }

  if (event.status === "returned_to_ho") {
    if (!legacyAlreadySent) {
    notifications.push({
      recipient: "customer",
      chat_id: customerChat,
      body: templates.returnedApology(),
      notification_type: "customer_returned",
      dedupe_key: `delivery:${tracked.order.id}:customer_returned`,
    });
    }
    if (ownerChat) {
      notifications.push({
        recipient: "owner",
        chat_id: ownerChat,
        body: [
          "↩️ PARCEL RETURNED TO HEAD OFFICE",
          `Order: ${tracked.order.order_no ?? tracked.order.id}`,
          `Customer: ${tracked.order.customer_name}`,
          `Phone: ${tracked.order.phone_number}`,
          `Tracking: ${event.trackingId}`,
          `Attempts: ${event.attemptNo}`,
          event.reason ? `Reason: ${event.reason}` : "",
        ].filter(Boolean).join("\n"),
        notification_type: "owner_terminal_return",
        dedupe_key: `delivery:${tracked.order.id}:owner_terminal_return`,
      });
    }
  }

  return ingestDeliveryEvent({
    event_key: event.eventKey,
    tracking_id: event.trackingId,
    status: event.status,
    attempt_no: event.attemptNo,
    reason: event.reason,
    occurred_at: event.occurredAt,
    next_delivery_date: event.nextDeliveryDate,
    call_due_at: callDueAt,
    source,
    raw_payload: event.raw as unknown as Record<string, unknown>,
    notifications: sendNotifications ? notifications : [],
  });
}
