import { createHash } from "crypto";
import type { DeliveryEventStatus } from "./types";

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
]);

export function normalizeDeliveryStatus(raw: string): DeliveryEventStatus | null {
  const value = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (value.includes("returned_to_branch_rescheduled")) return "branch_rescheduled";
  if (value.includes("returned_to_branch_failed")) return "branch_failed";
  if (value.includes("returned_to_ho") || value.includes("received_by_client")) return "returned_to_ho";
  if (value.includes("out_for_delivery")) return "out_for_delivery";
  if (value.includes("reschedul")) return "rescheduled";
  if (value.includes("failed") && value.includes("deliver")) return "failed_to_deliver";
  if (value === "delivered" || value.includes("successfully_delivered")) return "delivered";
  return null;
}

export function parseAttemptNumber(remarks: string | null | undefined): number | null {
  const match = remarks?.match(/\battempt\s*[:#-]?\s*(\d+)\b/i);
  const parsed = match ? Number.parseInt(match[1], 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseRescheduleDate(remarks: string | null | undefined): string | null {
  const match = remarks?.match(/\breschedule\s*date\s*:\s*(\d{4}-\d{2}-\d{2})\b/i);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T00:00:00+05:30`);
  return Number.isNaN(parsed.getTime()) ? null : match[1];
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
    const nextDeliveryDate = status === "rescheduled" ? parseRescheduleDate(reason) : null;
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
