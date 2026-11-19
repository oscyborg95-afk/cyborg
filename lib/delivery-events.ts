import { createHash } from "crypto";
import type { ParsedCourierWebhook } from "./courier-webhook.ts";
import type { DeliveryEventStatus, OrderStatus } from "./types.ts";

export interface CourierHistoryRow {
  status_name: string;
  status_created_at: string;
  remarks: string | null;
}

export interface NormalizedDeliveryEvent {
  eventKey: string;
  trackingId: string;
  status: DeliveryEventStatus;
  attemptNo: number;
  reason: string;
  occurredAt: string;
  nextDeliveryDate: string | null;
  raw: CourierHistoryRow;
}

type PublicTrackingSection = {
  key?: string;
  value?: unknown;
};

type PublicTrackingResponse = {
  data?: PublicTrackingSection[];
};

const RECOGNIZED = new Set<DeliveryEventStatus>([
  "out_for_delivery",
  "rescheduled",
  "branch_rescheduled",
  "failed_to_deliver",
  "branch_failed",
  "delivered",
  "returned_to_ho",
  "cancelled",
]);

// Statuses after which the courier will not move the parcel again: the order
// leaves "booked", stops being polled, and its delivery attempt is closed.
export const TERMINAL_DELIVERY_STATUSES: ReadonlySet<DeliveryEventStatus> = new Set([
  "delivered",
  "returned_to_ho",
  "cancelled",
]);

export function isTerminalDeliveryStatus(status: DeliveryEventStatus): boolean {
  return TERMINAL_DELIVERY_STATUSES.has(status);
}

// What a booked order becomes once the courier reports this status. A
// courier-cancelled waybill is our "cancelled", not "returned": in every
// case seen so far the parcel was never collected, so no courier legs were
// charged and the unit never left the shed. Both put the stock back.
export function orderStatusForDeliveryEvent(status: DeliveryEventStatus): OrderStatus | null {
  if (status === "delivered") return "delivered";
  if (status === "returned_to_ho") return "returned";
  if (status === "cancelled") return "cancelled";
  return null;
}

// orders.cancel_reason is shown on the Orders screen next to a manual
// cancellation, so it says who cancelled and keeps the courier's own words.
export function courierCancelReason(remarks: string | null | undefined): string {
  const note = remarks?.replace(/\s+/g, " ").trim() ?? "";
  return (note ? `Cancelled by courier: ${note}` : "Cancelled by courier").slice(0, 200);
}

// A courier cancellation reaches us whenever the poller next looks, which
// for the parcels it missed was weeks or months later. Only a recent one is
// still worth interrupting the owner for.
export const COURIER_CANCEL_ALERT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export function isRecentCourierEvent(
  occurredAt: string,
  now = new Date(),
  maxAgeMs = COURIER_CANCEL_ALERT_MAX_AGE_MS
): boolean {
  const at = Date.parse(occurredAt);
  return Number.isFinite(at) && now.getTime() - at <= maxAgeMs;
}

export function normalizeDeliveryStatus(raw: string): DeliveryEventStatus | null {
  const value = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (value.includes("returned_to_branch_rescheduled")) return "branch_rescheduled";
  if (value.includes("returned_to_branch_failed")) return "branch_failed";
  if (value.includes("returned_to_ho") || value.includes("received_by_client")) return "returned_to_ho";
  if (value.includes("out_for_delivery")) return "out_for_delivery";
  if (value.includes("reschedul")) return "rescheduled";
  if (value.includes("failed") && value.includes("deliver")) return "failed_to_deliver";
  if (value === "delivered" || value.includes("successfully_delivered")) return "delivered";
  // Trans Express ends a parcel the store asked to deliver for a reduced amount
  // as "Partially Delivered" ("Collected COD Rs. 1.00. Requested by online
  // store"). It is finished and on the next invoice; ignoring it left the order
  // in transit until the invoice import, invisible to the payout estimate. The
  // raw status and remark stay on the event so the estimate can read the
  // amount actually collected.
  if (value.includes("partially_delivered")) return "delivered";
  // Trans Express voids a booking it never collected within 14 days:
  // "Processing" → "Cancelled", remark "Orders older than 14 day(s) have been
  // canceled automatically." Ignoring it left those orders booked and polled
  // forever. Both spellings ("cancelled", "canceled") match.
  if (value.includes("cancel")) return "cancelled";
  return null;
}

export function parseAttemptNumber(remarks: string | null | undefined): number | null {
  const match = remarks?.match(/\battempt\s*[:#-]?\s*(\d+)\b/i);
  const parsed = match ? Number.parseInt(match[1], 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

const iso = (year: number, month: number, day: number) =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

// Couriers label the new date inconsistently ("Reschedule Date :", "Next
// Delivery Date -", …) and write it either ISO or Sri Lankan day-first. Every
// variant has to land on the same YYYY-MM-DD, because that string is part of
// the notification dedupe key — a format we fail to parse silently degrades
// into a less stable key and lets a duplicate message through.
// "delivery" on its own is deliberately not a label — "Out for delivery
// 2026-07-30" must not be read as a new delivery date.
const RESCHEDULE_DATE_LABEL = new RegExp(
  "\\b(?:" +
    "re-?schedule(?:d)?(?:\\s*date|\\s*on|\\s*to|\\s*for)?" +
    "|next\\s*delivery(?:\\s*date)?" +
    "|re-?delivery(?:\\s*date)?" +
    "|delivery\\s*date" +
    ")\\s*[:\\-=]?\\s*",
  "gi"
);

function dateAt(text: string): string | null {
  const isoMatch = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number);
    return isRealDate(y, m, d) ? iso(y, m, d) : null;
  }
  const dayFirst = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?!\d)/);
  if (dayFirst) {
    const [, d, m, y] = dayFirst.map(Number);
    return isRealDate(y, m, d) ? iso(y, m, d) : null;
  }
  return null;
}

export function parseRescheduleDate(remarks: string | null | undefined): string | null {
  if (!remarks) return null;
  // A remark often carries the label twice ("Rescheduled - no answer.
  // Reschedule Date : 2026-07-30"); read the date that follows any of them.
  const labels = new RegExp(RESCHEDULE_DATE_LABEL.source, "gi");
  for (const match of remarks.matchAll(labels)) {
    const found = dateAt(remarks.slice((match.index ?? 0) + match[0].length));
    if (found) return found;
  }
  return null;
}

// The same courier event can reach us as a webhook payload and as a polled
// history row, with the date sitting in a different field each time. Scanning
// every text the source gave us keeps both paths on one dedupe key.
export function rescheduleDateFrom(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    const found = parseRescheduleDate(text);
    if (found) return found;
  }
  return null;
}

export function courierTimestampToIso(value: string): string {
  const normalized = value.trim().replace(" ", "T");
  const parsed = new Date(`${normalized}+05:30`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid courier timestamp: ${value}`);
  return parsed.toISOString();
}

export function extractPublicTrackingHistory(payload: unknown): CourierHistoryRow[] {
  const data = (payload as PublicTrackingResponse | null)?.data;
  if (!Array.isArray(data)) return [];
  const section = data.find((item) => item?.key === "tracking_history");
  if (!section || !Array.isArray(section.value)) return [];
  return section.value.filter((row): row is CourierHistoryRow => {
    if (!row || typeof row !== "object") return false;
    const value = row as Partial<CourierHistoryRow>;
    return typeof value.status_name === "string" && typeof value.status_created_at === "string";
  });
}

export function normalizeCourierHistory(
  trackingId: string,
  rows: CourierHistoryRow[]
): NormalizedDeliveryEvent[] {
  let currentAttempt = 0;
  const normalized: NormalizedDeliveryEvent[] = [];
  const sorted = [...rows].sort(
    (a, b) => courierTimestampToIso(a.status_created_at).localeCompare(courierTimestampToIso(b.status_created_at))
  );

  for (const row of sorted) {
    const status = normalizeDeliveryStatus(row.status_name);
    if (!status || !RECOGNIZED.has(status)) continue;
    const explicitAttempt = parseAttemptNumber(row.remarks);
    if (status === "out_for_delivery") {
      currentAttempt = explicitAttempt ?? currentAttempt + 1;
    } else if (currentAttempt === 0) {
      currentAttempt = explicitAttempt ?? 1;
    } else if (explicitAttempt) {
      currentAttempt = explicitAttempt;
    }
    const occurredAt = courierTimestampToIso(row.status_created_at);
    const reason = row.remarks?.trim() ?? "";
    const nextDeliveryDate =
      status === "rescheduled" || status === "branch_rescheduled"
        ? rescheduleDateFrom(reason, row.status_name)
        : null;
    const eventKey = createHash("sha256")
      .update([trackingId, status, currentAttempt, row.status_created_at, reason].join("\n"))
      .digest("hex");
    normalized.push({
      eventKey,
      trackingId,
      status,
      attemptNo: Math.max(currentAttempt, 1),
      reason,
      occurredAt,
      nextDeliveryDate,
      raw: row,
    });
  }
  return normalized;
}

// --- Webhook → canonical event -------------------------------------------
// The webhook and the poller used to build NormalizedDeliveryEvent separately,
// each with its own status mapping and date parsing. When the two disagreed the
// notification dedupe key differed and the customer got the same message twice.
// Both paths now converge here.

export function webhookOccurredAt(value: string | null | undefined): string {
  if (!value) return new Date().toISOString();
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime()) && /(?:Z|[+-]\d\d:?\d\d)$/i.test(value)) {
    return direct.toISOString();
  }
  const local = new Date(`${value.trim().replace(" ", "T")}+05:30`);
  return Number.isNaN(local.getTime()) ? new Date().toISOString() : local.toISOString();
}

export function canonicalWebhookStatus(
  event: Pick<ParsedCourierWebhook, "status" | "rawStatus">
): DeliveryEventStatus | null {
  // Classify from the courier's own wording first: the coarse webhook status
  // collapses "returned to branch - rescheduled" into a plain reschedule, which
  // would message the customer on a state the poller (correctly) stays quiet on.
  const fromRaw = event.rawStatus ? normalizeDeliveryStatus(event.rawStatus) : null;
  if (fromRaw && RECOGNIZED.has(fromRaw)) return fromRaw;
  if (event.status === "returned") return "returned_to_ho";
  if (event.status === "cancelled") return "cancelled";
  if (event.status === "redelivery") return "out_for_delivery";
  return normalizeDeliveryStatus(event.status);
}

export function normalizeWebhookEvent(
  event: ParsedCourierWebhook,
  fingerprint: string,
  extraText: Array<string | null | undefined> = []
): NormalizedDeliveryEvent | null {
  const status = canonicalWebhookStatus(event);
  if (!status) return null;
  const occurredAt = webhookOccurredAt(event.occurredAt);
  return {
    eventKey: `webhook:${fingerprint}`,
    trackingId: event.trackingId,
    status,
    attemptNo: Math.max(event.attempt ?? 1, 1),
    reason: event.remarks,
    occurredAt,
    nextDeliveryDate:
      status === "rescheduled" || status === "branch_rescheduled"
        ? rescheduleDateFrom(event.remarks, event.rawStatus, ...extraText)
        : null,
    raw: {
      status_name: event.rawStatus || event.status,
      status_created_at: event.occurredAt ?? occurredAt,
      remarks: event.remarks,
    },
  };
}

export function ownerCallDueAt(
  nextDeliveryDate: string | null,
  occurredAt: string,
  now = new Date()
): string {
  if (!nextDeliveryDate) return now.toISOString();
  const due = new Date(`${nextDeliveryDate}T18:00:00+05:30`);
  due.setDate(due.getDate() - 1);
  const occurred = new Date(occurredAt);
  return due.getTime() > Math.max(occurred.getTime(), now.getTime())
    ? due.toISOString()
    : now.toISOString();
}

export function scheduledMorningAt(nextDeliveryDate: string | null): string | null {
  if (!nextDeliveryDate) return null;
  return new Date(`${nextDeliveryDate}T07:00:00+05:30`).toISOString();
}
