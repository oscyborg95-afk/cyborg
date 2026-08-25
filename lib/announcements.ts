// Operator-written announcements to customers with a parcel in flight.
//
// This is deliberately NOT an automation: nothing here fires on a schedule or
// on a courier event. The operator picks the audience, types the message, and
// watches it go out. It exists for the days the whole pipeline stalls for a
// reason the courier will never report — a poya day, a mercantile holiday, a
// strike — where the customers who need telling are the ones whose parcel is
// already booked, or confirmed and waiting to be booked.
//
// Sends go through the existing tracking_notification_jobs outbox rather than
// a browser loop, so closing the tab mid-send cannot leave half an audience
// uninformed: the queue survives, and the ordinary cron drain sweeps up.

import { randomUUID } from "crypto";
import {
  enqueueAnnouncement,
  listAnnouncementBatchJobs,
  listAnnouncementCandidates,
  type AnnouncementCandidate,
} from "./db.ts";
import { phoneToChatId } from "./phone.ts";
import type { OrderStatus } from "./types.ts";

// The only two statuses a live announcement can sensibly target. `booked` is
// the parcel already with the courier; `pending` is confirmed but not yet
// handed over. Delivered and returned orders are finished business.
export const ANNOUNCEMENT_AUDIENCES = ["booked", "pending"] as const;
export type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export function parseAudiences(raw: string | null): AnnouncementAudience[] {
  const wanted = (raw ?? "booked")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is AnnouncementAudience =>
      (ANNOUNCEMENT_AUDIENCES as readonly string[]).includes(value)
    );
  return wanted.length > 0 ? wanted : ["booked"];
}

// One message goes to one person, not to one parcel: a customer with two
// booked orders hears from us once, with both order numbers in the text.
export interface AnnouncementRecipient {
  phone_key: string;
  phone_number: string;
  chat_id: string;
  customer_name: string;
  city: string;
  district: string;
  order_ids: string[];
  order_nos: string[];
  tracking_ids: string[];
  total_cod: number;
  statuses: OrderStatus[];
  booked_at: string; // oldest parcel in the group — "waiting longest"
  last_message_at: string | null;
}

const phoneKeyOf = (phone: string) => phone.replace(/\D/g, "").slice(-9);

export function groupCandidates(candidates: AnnouncementCandidate[]): AnnouncementRecipient[] {
  const byPhone = new Map<string, AnnouncementRecipient>();
  for (const row of candidates) {
    const key = phoneKeyOf(row.phone_number);
    if (key.length < 9) continue; // unreachable number — nothing to send to
    const existing = byPhone.get(key);
    if (!existing) {
      byPhone.set(key, {
        phone_key: key,
        phone_number: row.phone_number,
        chat_id: phoneToChatId(row.phone_number),
        customer_name: row.customer_name,
        city: row.city,
        district: row.district,
        order_ids: [row.order_id],
        order_nos: row.order_no ? [row.order_no] : [],
        tracking_ids: row.tracking_id ? [row.tracking_id] : [],
        total_cod: row.total_cod,
        statuses: [row.order_status],
        booked_at: row.booked_at,
        last_message_at: row.last_message_at,
      });
      continue;
    }
    existing.order_ids.push(row.order_id);
    if (row.order_no) existing.order_nos.push(row.order_no);
    if (row.tracking_id) existing.tracking_ids.push(row.tracking_id);
    existing.total_cod += row.total_cod;
    if (!existing.statuses.includes(row.order_status)) existing.statuses.push(row.order_status);
    if (row.booked_at < existing.booked_at) existing.booked_at = row.booked_at;
    if (
      row.last_message_at &&
      (!existing.last_message_at || row.last_message_at > existing.last_message_at)
    ) {
      existing.last_message_at = row.last_message_at;
    }
  }
  return [...byPhone.values()].sort((a, b) => b.booked_at.localeCompare(a.booked_at));
}

export async function listAnnouncementRecipients(
  audiences: AnnouncementAudience[]
): Promise<AnnouncementRecipient[]> {
  return groupCandidates(await listAnnouncementCandidates(audiences));
}

// Anyone we messaged this recently starts unticked in the UI: a holiday notice
// landing minutes after an automated "out for delivery" reads as chaos.
export const RECENT_CONTACT_HOURS = 6;

export function messagedRecently(
  recipient: AnnouncementRecipient,
  now: Date = new Date()
): boolean {
  if (!recipient.last_message_at) return false;
  const age = now.getTime() - new Date(recipient.last_message_at).getTime();
  return age >= 0 && age < RECENT_CONTACT_HOURS * 3_600_000;
}

export const ANNOUNCEMENT_PLACEHOLDERS = [
  "{{name}}",
  "{{order_no}}",
  "{{tracking}}",
  "{{total}}",
] as const;

// Same contract as lib/templates.ts: substitute, then drop any line whose
// placeholders all went unresolved, so a customer whose parcel has no waybill
// yet simply does not get a tracking line.
export function renderAnnouncement(source: string, recipient: AnnouncementRecipient): string {
  const firstName = recipient.customer_name.trim().split(/\s+/)[0] ?? "";
  const substituted = source
    .replaceAll("{{name}}", firstName || "{{name}}")
    .replaceAll("{{order_no}}", recipient.order_nos.join(", ") || "{{order_no}}")
    .replaceAll("{{tracking}}", recipient.tracking_ids.join(", ") || "{{tracking}}")
    // A customer with two parcels in flight will pay for both, so the total is
    // summed across the group rather than shown per parcel.
    .replaceAll("{{total}}", String(recipient.total_cod));
  return substituted
    .split("\n")
    .filter((line) => !/\{\{(name|order_no|tracking|total)\}\}/.test(line))
    .join("\n");
}

// The line-dropping rule has a sharp edge: write "Tracking: {{tracking}}" at
// the end of a paragraph rather than on its own line, and a customer with no
// waybill yet loses the whole paragraph — sometimes the entire message. Rather
// than silently sending nothing, callers check this first and the operator gets
// told which recipients it would happen to.
export function recipientsWithEmptyBody(
  body: string,
  recipients: AnnouncementRecipient[]
): AnnouncementRecipient[] {
  return recipients.filter((recipient) => !renderAnnouncement(body, recipient).trim());
}

export interface QueueAnnouncementResult {
  batch_id: string;
  queued: number;
  skipped: number;
  recipients: number;
}

export class EmptyAnnouncementBodyError extends Error {
  readonly names: string[];

  constructor(names: string[]) {
    super(
      `The message comes out blank for ${names.length} customer${names.length === 1 ? "" : "s"} ` +
        `(${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}). ` +
        `A line is dropped when every placeholder on it is unresolved — put {{tracking}} on its own line.`
    );
    this.names = names;
  }
}

// Queue one batch. Every job carries `announce:<batch>:<order_id>` as its
// dedupe key, which the unique index turns into a hard guarantee: a
// double-tapped Send, or a retry of this request, cannot message anyone twice.
export async function queueAnnouncement(input: {
  body: string;
  phoneKeys: string[];
  audiences: AnnouncementAudience[];
}): Promise<QueueAnnouncementResult> {
  const batchId = randomUUID();
  const wanted = new Set(input.phoneKeys);
  const recipients = (await listAnnouncementRecipients(input.audiences)).filter((r) =>
    wanted.has(r.phone_key)
  );

  const empties = recipientsWithEmptyBody(input.body, recipients);
  if (empties.length > 0) {
    throw new EmptyAnnouncementBodyError(empties.map((r) => r.customer_name));
  }

  let queued = 0;
  let skipped = 0;
  for (const recipient of recipients) {
    const body = renderAnnouncement(input.body, recipient);
    // One message per person; the job hangs off their oldest parcel so the
    // order's own message history shows it.
    const anchorOrderId = recipient.order_ids[recipient.order_ids.length - 1];
    const created = await enqueueAnnouncement({
      order_id: anchorOrderId,
      chat_id: recipient.chat_id,
      body,
      dedupe_key: `announce:${batchId}:${anchorOrderId}`,
    });
    if (created) queued++;
    else skipped++;
  }
  return { batch_id: batchId, queued, skipped, recipients: recipients.length };
}

export interface AnnouncementBatchProgress {
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  waiting: number;
  // Surfaced so the send screen can say *why* nothing is going out — an
  // offline WhatsApp worker otherwise looks identical to a slow send.
  last_error: string;
  jobs: {
    chat_id: string;
    status: string;
    last_error: string;
  }[];
}

export async function getAnnouncementProgress(
  batchId: string
): Promise<AnnouncementBatchProgress> {
  const jobs = await listAnnouncementBatchJobs(batchId);
  const count = (status: string) => jobs.filter((job) => job.status === status).length;
  return {
    total: jobs.length,
    sent: count("sent"),
    failed: jobs.filter((job) => job.status === "failed" && job.attempts >= 6).length,
    skipped: count("skipped"),
    waiting: jobs.filter((job) => ["pending", "processing", "failed"].includes(job.status) && job.attempts < 6).length,
    last_error: [...jobs].reverse().find((job) => job.last_error)?.last_error ?? "",
    jobs: jobs.map((job) => ({
      chat_id: job.chat_id,
      status: job.status,
      last_error: job.last_error,
    })),
  };
}

export const announcementBatchPrefix = (batchId: string) => `announce:${batchId}:`;
