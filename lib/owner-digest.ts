import {
  enqueueOwnerDigest,
  getSettings,
  listAttemptsForDigestDate,
  listUndatedOpenAttempts,
  skipSupersededReminders,
  type OwnerDigestRow,
} from "./db.ts";
import { phoneToChatId } from "./phone.ts";

// One owner message per run instead of one per parcel.
//
// Every rescheduled parcel used to queue its own "call reminder" (18:00 the day
// before) and its own "delivery today" nudge (07:00 on the day). Ten rescheduled
// parcels meant ten WhatsApps in one burst, which is unreadable and trains the
// owner to ignore the channel. The per-parcel reminders are gone from
// delivery-workflow.ts; these two digests replace them. Genuinely urgent,
// per-parcel events — a fresh reschedule, a return — still alert immediately.

export type DigestKind = "morning" | "evening";

const MAX_LINES = 25;

export function colomboDate(now = new Date(), dayOffset = 0): string {
  const shifted = new Date(now.getTime() + dayOffset * 86_400_000);
  // en-CA renders ISO-shaped YYYY-MM-DD, which is what next_delivery_date holds.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(shifted);
}

function headingDate(date: string): string {
  return new Intl.DateTimeFormat("en-LK", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Asia/Colombo",
  }).format(new Date(`${date}T12:00:00+05:30`));
}

function statusLabel(row: OwnerDigestRow): string {
  switch (row.status) {
    case "branch_rescheduled":
      return "Back at branch, rescheduled";
    case "rescheduled":
      return "Rescheduled";
    case "failed_to_deliver":
    case "branch_failed":
      return "Delivery failed";
    case "out_for_delivery":
      return "Out for delivery";
    default:
      return row.status.replaceAll("_", " ");
  }
}

// Attempt 3 is the last one most couriers make before sending the parcel back,
// so it is the line the owner has to act on first.
function riskMark(row: OwnerDigestRow): string {
  if (row.call_status === "called_confirmed") return "✅";
  if (row.attempt_no >= 3) return "🚨";
  if (row.attempt_no === 2) return "⚠️";
  return "•";
}

function parcelLine(row: OwnerDigestRow, index: number): string {
  const next = row.attempt_no + 1;
  return [
    `${index}. ${riskMark(row)} ${row.tracking_id} · ${row.customer_name}`,
    `    ${statusLabel(row)} · attempt ${row.attempt_no} (next: ${next})`,
  ].join("\n");
}

function section(rows: OwnerDigestRow[], startAt = 1): string[] {
  const shown = rows.slice(0, MAX_LINES);
  const lines = shown.map((row, i) => parcelLine(row, startAt + i));
  if (rows.length > shown.length) {
    lines.push(`    …and ${rows.length - shown.length} more — open the dashboard.`);
  }
  return lines;
}

export function buildDigestBody(
  kind: DigestKind,
  date: string,
  dated: OwnerDigestRow[],
  undated: OwnerDigestRow[]
): string | null {
  if (dated.length === 0 && undated.length === 0) return null;
  const pending = dated.filter((row) => row.call_status !== "called_confirmed").length;
  const head =
    kind === "morning"
      ? [
          `🌅 TODAY'S DELIVERIES — ${headingDate(date)}`,
          `${dated.length} parcel${dated.length === 1 ? "" : "s"} scheduled${
            pending < dated.length ? ` · ${pending} still uncalled` : ""
          }`,
        ]
      : [
          `📞 TOMORROW'S DELIVERIES — ${headingDate(date)}`,
          `${dated.length} parcel${dated.length === 1 ? "" : "s"} to confirm before the courier goes out`,
        ];

  const body = [...head, ""];
  if (dated.length) body.push(...section(dated));
  if (undated.length) {
    if (dated.length) body.push("");
    body.push(`⚠️ No delivery date from courier (${undated.length}) — call to set one:`);
    body.push(...section(undated, 1));
  }
  body.push("", "🚨 = attempt 3+, high return risk · ✅ = already confirmed");
  return body.join("\n");
}

// Builds and queues the digest. Idempotent: the dedupe key is one per kind per
// Colombo day, so extra drains during the day are no-ops.
export async function queueOwnerDigest(
  kind: DigestKind,
  now = new Date()
): Promise<{ queued: boolean; parcels: number; reason?: string }> {
  const settings = await getSettings();
  const ownerPhone = settings.business_phone_1.trim();
  if (!ownerPhone) return { queued: false, parcels: 0, reason: "No owner phone configured" };

  const targetDate = colomboDate(now, kind === "morning" ? 0 : 1);
  const dated = await listAttemptsForDigestDate(targetDate);
  // The morning digest is a "what is happening today" list; undated parcels have
  // nothing happening today, and they are already in last night's evening list.
  const undated = kind === "evening" ? await listUndatedOpenAttempts() : [];

  // Do this even when there is nothing to send: the superseded per-parcel
  // reminders must be cleared out on the first run either way.
  await skipSupersededReminders();

  const body = buildDigestBody(kind, targetDate, dated, undated);
  if (!body) return { queued: false, parcels: 0, reason: "Nothing scheduled" };

  const queued = await enqueueOwnerDigest({
    order_id: (dated[0] ?? undated[0]).order_id,
    chat_id: phoneToChatId(ownerPhone),
    body,
    notification_type: `owner_${kind}_digest`,
    dedupe_key: `owner:${kind}_digest:${colomboDate(now)}`,
  });
  return { queued, parcels: dated.length + undated.length };
}
