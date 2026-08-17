// Pure decision rules for the automatic follow-up engine. Everything here is
// side-effect free so the rules that decide *whether a cold lead gets another
// WhatsApp* can be tested without a database or a live socket.
//
// The engine sits on an unofficial Baileys connection, which means a burst of
// near-identical outbound messages to people who have not replied is the exact
// pattern that gets a number banned. These rules are the throttle.

import type { ChatStateValue, FollowUpSequence, FollowUpSettings, FollowUpStep } from "./types";

export const FOLLOW_UP_TRIGGER_STATES: ChatStateValue[] = [
  "NEW",
  "AWAITING_ADDRESS",
  "AWAITING_CONFIRMATION",
];

// A reply containing any of these ends the sequence permanently. Sinhala,
// Singlish and English all appear in the same inbox, so all three are covered.
const OPT_OUT_PATTERNS = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bdon'?t\s+(?:message|msg|text|contact)\b/i,
  /\bno\s+more\s+(?:messages|msgs)\b/i,
  /එපා/,
  /නවත්වන්න/,
  /මැසේජ්\s*එවන්න\s*එපා/,
  /\bepa\b/i,
];

export function isOptOutReply(body: string): boolean {
  const text = (body || "").trim();
  if (!text) return false;
  return OPT_OUT_PATTERNS.some((pattern) => pattern.test(text));
}

function colomboTime(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

// The daylight window follow-ups are allowed to go out in. Deliberately
// narrower than the agent's quiet hours: a reminder nobody asked for at 21:30
// reads as spam even though a *reply* at 21:30 would be welcome.
export function insideSendWindow(
  settings: Pick<FollowUpSettings, "window_start" | "window_end">,
  date = new Date()
): boolean {
  const time = colomboTime(date);
  const { window_start: start, window_end: end } = settings;
  if (start === end) return true; // degenerate window = always open
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export type DispatchBlock = "quiet_hours" | "outside_window" | "daily_cap" | "min_gap";

// The whole throttle in one place: the four reasons a tick is allowed to find
// due work and still send nothing. Kept pure so the limits protecting the
// WhatsApp number are covered by tests rather than by a live experiment.
export function dispatchBlockReason(
  settings: Pick<FollowUpSettings, "window_start" | "window_end" | "daily_cap" | "min_gap_minutes">,
  quietHours: boolean,
  pace: { sent_24h: number; last_sent_at: string | null },
  now = new Date()
): DispatchBlock | null {
  if (!insideSendWindow(settings, now)) return "outside_window";
  if (quietHours) return "quiet_hours";
  if (pace.sent_24h >= settings.daily_cap) return "daily_cap";
  if (
    pace.last_sent_at &&
    now.getTime() - Date.parse(pace.last_sent_at) < settings.min_gap_minutes * 60_000
  ) {
    return "min_gap";
  }
  return null;
}

// Deterministic variant choice. The same lead always gets the same wording for
// a given step (so a retry cannot change the message mid-flight), but two
// different leads on the same step usually get different text — which is both
// less robotic to read and much less detectable as bulk automation.
export function pickVariant(variants: string[], phoneKey: string, stepIndex: number): string {
  const usable = variants.map((v) => v.trim()).filter(Boolean);
  if (usable.length === 0) return "";
  let hash = 7;
  for (const char of `${phoneKey}:${stepIndex}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return usable[hash % usable.length];
}

export function renderFollowUp(
  body: string,
  vars: { name?: string; business?: string }
): string {
  // First name only — "Nimal" reads like a person wrote it, the full pushname
  // WhatsApp reports ("Nimal Perera 🌸 0771234567") does not.
  const firstName = (vars.name ?? "").trim().split(/\s+/)[0] ?? "";
  return body
    .replaceAll("{{name}}", firstName)
    .replaceAll("{{business}}", vars.business?.trim() || "Our shop")
    // Collapse the double space left behind by an empty {{name}}.
    .replace(/[ \t]{2,}/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

export function sequenceFor(
  settings: Pick<FollowUpSettings, "sequences">,
  triggerState: string
): FollowUpSequence | null {
  return settings.sequences.find((s) => s.trigger_state === triggerState && s.enabled) ?? null;
}

export function stepAt(sequence: FollowUpSequence, index: number): FollowUpStep | null {
  return sequence.steps[index] ?? null;
}

export interface EnrollmentCandidate {
  phone_key: string;
  chat_id: string;
  trigger_state: ChatStateValue;
  // When the lead last said anything to us. Null when we have no inbound record
  // at all, in which case the chat-state timestamp stands in for it.
  last_inbound_at: string | null;
  state_updated_at: string;
}

// "Cold" is measured from the lead's own last message, not from ours: someone
// who replied ten minutes ago is mid-conversation even if our last outbound was
// yesterday.
export function coldSince(candidate: EnrollmentCandidate): number {
  const inbound = candidate.last_inbound_at ? Date.parse(candidate.last_inbound_at) : NaN;
  const stateAt = Date.parse(candidate.state_updated_at);
  return Number.isFinite(inbound) ? inbound : stateAt;
}

export function shouldEnroll(
  settings: Pick<FollowUpSettings, "sequences">,
  candidate: EnrollmentCandidate,
  now = Date.now()
): boolean {
  const sequence = sequenceFor(settings, candidate.trigger_state);
  const first = sequence ? stepAt(sequence, 0) : null;
  if (!first) return false;
  const silentMs = now - coldSince(candidate);
  return silentMs >= first.delay_hours * 3_600_000;
}

export type StopReason =
  | "replied"
  | "converted"
  | "opted_out"
  | "ai_disabled"
  | "sequence_removed"
  | "completed";

export interface StopCheckInput {
  baseline_inbound_at: string | null;
  enrolled_at: string;
  // Current values, read fresh at send time — a job queued four hours ago must
  // never send on a snapshot taken four hours ago.
  last_inbound_at: string | null;
  chat_state: string | null;
  has_order: boolean;
  opted_out: boolean;
  ai_enabled: boolean;
}

// Evaluated immediately before every single send, never at enqueue time. This
// is the check that stops a customer who already replied — or already bought —
// from being chased by yesterday's schedule.
export function stopReasonFor(input: StopCheckInput): StopReason | null {
  if (input.opted_out) return "opted_out";
  if (!input.ai_enabled) return "ai_disabled";
  if (input.has_order) return "converted";
  if (input.chat_state === "CONFIRMED" || input.chat_state === "SHIPPED") return "converted";

  const latest = input.last_inbound_at ? Date.parse(input.last_inbound_at) : NaN;
  if (!Number.isFinite(latest)) return null;
  // No baseline means we had never heard from them when we enrolled, so any
  // inbound message at all after enrolment is a reply.
  const baseline = input.baseline_inbound_at
    ? Date.parse(input.baseline_inbound_at)
    : Date.parse(input.enrolled_at);
  return latest > baseline ? "replied" : null;
}

export const STOP_REASON_LABELS: Record<StopReason, string> = {
  replied: "Customer replied",
  converted: "Order confirmed",
  opted_out: "Customer opted out",
  ai_disabled: "Automation disabled for this customer",
  sequence_removed: "Sequence no longer active",
  completed: "Sequence finished",
};
