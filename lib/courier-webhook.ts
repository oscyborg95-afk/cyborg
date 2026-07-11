export type CourierWebhookStatus =
  | "out_for_delivery" | "rescheduled" | "failed_to_deliver" | "redelivery"
  | "delivered" | "returned" | "cancelled" | "in_transit";

export interface ParsedCourierWebhook {
  trackingId: string;
  status: CourierWebhookStatus;
  remarks: string;
  attempt: number | null;
}

export interface CourierWebhookParseResult {
  event: ParsedCourierWebhook | null;
  observedKeys: string[];
  missing: string[];
}

function entriesDeep(value: unknown, depth = 0): Array<[string, unknown]> {
  if (!value || typeof value !== "object" || depth > 4) return [];
  const out: Array<[string, unknown]> = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.push([key.toLowerCase(), child]);
    if (child && typeof child === "object") out.push(...entriesDeep(child, depth + 1));
  }
  return out;
}

function firstText(entries: Array<[string, unknown]>, keys: string[]): string {
  for (const wanted of keys) {
    const found = entries.find(([key, value]) =>
      key === wanted && (typeof value === "string" || typeof value === "number")
    );
    if (found) return String(found[1]).trim();
  }
  return "";
}

export function normalizeCourierWebhookStatus(raw: string): CourierWebhookStatus {
  const value = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (value.includes("out_for_delivery")) return "out_for_delivery";
  if (value.includes("reschedul")) return "rescheduled";
  if (value.includes("failed") && value.includes("deliver")) return "failed_to_deliver";
  if (value.includes("re_delivery") || value.includes("redelivery")) return "redelivery";
  if (value.includes("deliver") && !value.includes("partial")) return "delivered";
  if (value.includes("return") || value.includes("received_by_client")) return "returned";
  if (value.includes("cancel")) return "cancelled";
  return "in_transit";
}

export function parseCourierWebhook(payload: unknown): ParsedCourierWebhook | null {
  const entries = entriesDeep(payload);
  const trackingId = firstText(entries, [
    "waybill_id", "waybill", "tracking_id", "tracking_no", "tracking_number",
  ]);
  const rawStatus = firstText(entries, [
    "mapped_status", "status", "status_name", "current_status", "delivery_status", "state",
  ]);
  if (!trackingId || !rawStatus) return null;
  const remarks = firstText(entries, ["remarks", "remark", "comment", "note", "reason"]);
  const attemptText = firstText(entries, [
    "delivery_attempts", "delivery_attempt", "attempt_count", "attempt",
  ]);
  const parsedAttempt = Number.parseInt(attemptText, 10);
  return {
    trackingId,
    status: normalizeCourierWebhookStatus(rawStatus),
    remarks,
    attempt: Number.isFinite(parsedAttempt) && parsedAttempt > 0 ? parsedAttempt : null,
  };
}

// Strict envelope used by the route: every payload is captured with its key
// shape, while missing identity fields are rejected instead of guessed.
export function inspectCourierWebhook(payload: unknown): CourierWebhookParseResult {
  const entries = entriesDeep(payload);
  const observedKeys = [...new Set(entries.map(([key]) => key))].sort();
  const event = parseCourierWebhook(payload);
  const missing: string[] = [];
  if (!event?.trackingId) missing.push("waybill_id");
  if (!event) {
    const hasStatus = entries.some(([key, value]) =>
      ["mapped_status", "status", "status_name", "current_status", "delivery_status", "state"].includes(key) &&
      (typeof value === "string" || typeof value === "number")
    );
    if (!hasStatus) missing.push("status");
  }
  return { event, observedKeys, missing };
}

export function webhookCheckpoint(event: ParsedCourierWebhook): string {
  const label = event.status.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return [label, event.attempt ? `attempt ${event.attempt}` : "", event.remarks]
    .filter(Boolean)
    .join(" — ");
}

export function customerWebhookMessage(event: ParsedCourierWebhook): string | null {
  if (event.status === "rescheduled" || event.status === "failed_to_deliver") {
    return `ඔබගේ පැකේජය අද deliver කිරීමට නොහැකි වූ නිසා නැවත delivery සඳහා reschedule කර ඇත. 🙏\nකරුණාකර phone එක ළඟ තබාගන්න. Courier නැවත ඔබව සම්බන්ධ කරයි. 📞\n📦 Tracking: ${event.trackingId}`;
  }
  if (event.status === "redelivery") {
    return `ඔබගේ පැකේජය නැවත delivery සඳහා පිටත් කර ඇත. 🚚\nකරුණාකර phone එක ළඟ තබාගන්න. 📞\n📦 Tracking: ${event.trackingId}`;
  }
  return null;
}
