// The automatic follow-up engine.
//
// Two jobs, both driven by a ticker (worker/index.js, with a Vercel cron as the
// fallback):
//
//   1. enroll — find leads who went quiet mid-conversation and start a sequence
//   2. dispatch — send at most a couple of messages per tick, subject to the
//      send window, the rolling daily cap and a minimum gap between sends
//
// The pacing is the point. This runs over Baileys on the operator's own number,
// so follow-ups leave as a slow trickle spread across the day rather than a
// burst that looks exactly like the bulk messaging WhatsApp bans numbers for.

import {
  getAgentConfig,
  getCustomerProfile,
  listCustomerProfiles,
  recordCustomerEvent,
  updateCustomerProfile,
} from "./crm-db";
import { getSettings, listChatStates, listOrdersForCrm } from "./db";
import { insideQuietHours } from "./agent-policy";
import {
  FOLLOW_UP_TRIGGER_STATES,
  STOP_REASON_LABELS,
  dispatchBlockReason,
  isOptOutReply,
  pickVariant,
  renderFollowUp,
  sequenceFor,
  shouldEnroll,
  stepAt,
  stopReasonFor,
  type EnrollmentCandidate,
  type StopReason,
} from "./followup-policy";
import {
  claimDueEnrollments,
  enrollLead,
  failEnrollmentAttempt,
  getActiveEnrollmentKeys,
  getFollowUpSettings,
  getSendPace,
  recordFollowUpSend,
  stopActiveEnrollmentFor,
  stopEnrollment,
} from "./followups-db";
import { chatIdToPhone, phoneToChatId } from "./phone";
import { phoneKey } from "./risk";
import { getTenantSession } from "./tenant-context.ts";
import { sendTypingState, sendWhatsAppMessage } from "./wa";
import type { CustomerProfile } from "./types";

// Marked on the customer profile, so an opt-out survives every future sequence
// and is visible to the operator in the customer drawer.
export const FOLLOW_UP_OPT_OUT_TAG = "no-followup";

export interface FollowUpSweepResult {
  skipped?: "disabled" | "quiet_hours" | "outside_window" | "daily_cap" | "min_gap";
  enrolled: number;
  sent: number;
  stopped: number;
  failed: number;
  sent_24h: number;
}

const EMPTY: FollowUpSweepResult = {
  enrolled: 0,
  sent: 0,
  stopped: 0,
  failed: 0,
  sent_24h: 0,
};

// One sweep per tenant at a time — the cron and the worker ticker both call
// this, and two concurrent sweeps would each think they were under the gap.
const running = new Map<string, Promise<FollowUpSweepResult>>();

export function optedOut(profile: Pick<CustomerProfile, "tags"> | null): boolean {
  return Boolean(profile?.tags?.includes(FOLLOW_UP_OPT_OUT_TAG));
}

function jitter(minMs: number, maxMs: number): number {
  return Math.round(minMs + Math.random() * (maxMs - minMs));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runFollowUpSweep(options: { maxSends?: number } = {}) {
  const tenantId = (await getTenantSession())?.tenantId ?? "local";
  const active = running.get(tenantId);
  if (active) return active;
  const run = sweep(options).finally(() => running.delete(tenantId));
  running.set(tenantId, run);
  return run;
}

async function sweep(options: { maxSends?: number }): Promise<FollowUpSweepResult> {
  const settings = await getFollowUpSettings();
  if (!settings.enabled) return { ...EMPTY, skipped: "disabled" };

  const enrolled = await enrollColdLeads();
  const dispatched = await dispatchDue(options.maxSends ?? 1);
  return { ...dispatched, enrolled };
}

async function enrollColdLeads(): Promise<number> {
  const settings = await getFollowUpSettings();
  const [states, profiles, orders, activeKeys] = await Promise.all([
    listChatStates(),
    listCustomerProfiles(),
    listOrdersForCrm(),
    getActiveEnrollmentKeys(),
  ]);
  const profileByKey = new Map(profiles.map((p) => [p.phone_key, p]));
  // Anyone who has ever ordered is out of scope for a "you never replied"
  // chase, including the second number on the order.
  const ordered = new Set<string>();
  for (const order of orders) {
    ordered.add(phoneKey(order.phone_number));
    if (order.phone_2) ordered.add(phoneKey(order.phone_2));
  }

  let enrolled = 0;
  for (const state of states) {
    if (!FOLLOW_UP_TRIGGER_STATES.includes(state.state)) continue;
    const key = phoneKey(state.phone_number);
    if (key.length < 9 || activeKeys.has(key) || ordered.has(key)) continue;

    const profile = profileByKey.get(key) ?? null;
    if (profile && (!profile.ai_enabled || optedOut(profile))) continue;

    const candidate: EnrollmentCandidate = {
      phone_key: key,
      chat_id: state.chat_id || phoneToChatId(state.phone_number),
      trigger_state: state.state,
      last_inbound_at: profile?.last_inbound_at ?? null,
      state_updated_at: state.updated_at,
    };
    if (!shouldEnroll(settings, candidate)) continue;

    const created = await enrollLead({
      phone_key: key,
      chat_id: candidate.chat_id,
      trigger_state: candidate.trigger_state,
      baseline_inbound_at: candidate.last_inbound_at,
      // Already cold by the time we get here, so the first message is due now —
      // the pacer decides when it actually leaves.
      next_run_at: new Date().toISOString(),
    });
    if (created) enrolled++;
  }
  return enrolled;
}

async function dispatchDue(maxSends: number): Promise<FollowUpSweepResult> {
  const settings = await getFollowUpSettings();
  const agentConfig = await getAgentConfig();
  const now = new Date();

  const pace = await getSendPace();
  // The agent's own quiet hours are honoured on top of the (narrower) send
  // window, so widening the window can never message someone at 1am by accident.
  const blocked = dispatchBlockReason(settings, insideQuietHours(agentConfig, now), pace, now);
  if (blocked) return { ...EMPTY, sent_24h: pace.sent_24h, skipped: blocked };

  const budget = Math.max(1, Math.min(maxSends, settings.daily_cap - pace.sent_24h));
  // Claim a few more than the budget: cancellations (they replied, they ordered)
  // are common and must not consume a send slot.
  const candidates = await claimDueEnrollments(budget + 4);
  if (candidates.length === 0) return { ...EMPTY, sent_24h: pace.sent_24h };

  const business = await getSettings().then((s) => s.business_name).catch(() => "");
  const states = await listChatStates();
  const stateByKey = new Map(states.map((s) => [phoneKey(s.phone_number), s.state]));
  const orders = await listOrdersForCrm();
  const orderedKeys = new Set<string>();
  for (const order of orders) {
    orderedKeys.add(phoneKey(order.phone_number));
    if (order.phone_2) orderedKeys.add(phoneKey(order.phone_2));
  }

  let sent = 0;
  let stopped = 0;
  let failed = 0;

  for (const enrollment of candidates) {
    if (sent >= budget) break;

    const profile = await getCustomerProfile(enrollment.phone_key);
    const reason: StopReason | null = stopReasonFor({
      baseline_inbound_at: enrollment.baseline_inbound_at,
      enrolled_at: enrollment.enrolled_at,
      last_inbound_at: profile?.last_inbound_at ?? null,
      chat_state: stateByKey.get(enrollment.phone_key) ?? null,
      has_order: orderedKeys.has(enrollment.phone_key),
      opted_out: optedOut(profile),
      ai_enabled: profile ? profile.ai_enabled : true,
    });
    if (reason) {
      await stopEnrollment(enrollment.id, "stopped", STOP_REASON_LABELS[reason]);
      stopped++;
      continue;
    }

    const sequence = sequenceFor(settings, enrollment.trigger_state);
    if (!sequence) {
      await stopEnrollment(enrollment.id, "stopped", STOP_REASON_LABELS.sequence_removed);
      stopped++;
      continue;
    }
    const step = stepAt(sequence, enrollment.step_index);
    if (!step) {
      await stopEnrollment(enrollment.id, "done", STOP_REASON_LABELS.completed);
      stopped++;
      continue;
    }

    const body = renderFollowUp(
      pickVariant(step.variants, enrollment.phone_key, enrollment.step_index),
      { name: profile?.display_name ?? "", business }
    );
    if (!body.trim()) {
      await stopEnrollment(enrollment.id, "stopped", "Step has no message text");
      stopped++;
      continue;
    }

    try {
      // Typing for a beat before a message the customer did not ask for. The
      // pause is short and randomised; a follow-up that appears the instant the
      // previous one did is the tell that this is a machine.
      await sendTypingState(enrollment.chat_id, "composing");
      await sleep(jitter(1_200, 3_000));
      await sendWhatsAppMessage(
        enrollment.chat_id,
        body,
        undefined,
        undefined,
        undefined,
        `followup:${enrollment.id}:${enrollment.step_index}`
      );
      await sendTypingState(enrollment.chat_id, "paused");

      const nextStepIndex = enrollment.step_index + 1;
      const nextStep = stepAt(sequence, nextStepIndex);
      await recordFollowUpSend({
        enrollment_id: enrollment.id,
        phone_key: enrollment.phone_key,
        chat_id: enrollment.chat_id,
        step_index: enrollment.step_index,
        body,
        next_step_index: nextStep ? nextStepIndex : null,
        next_run_at: nextStep
          ? new Date(Date.now() + nextStep.delay_hours * 3_600_000).toISOString()
          : null,
      });
      await recordCustomerEvent({
        phone_key: enrollment.phone_key,
        chat_id: enrollment.chat_id,
        kind: "message_out",
        source: "system",
        payload: {
          follow_up: true,
          step: enrollment.step_index,
          trigger_state: enrollment.trigger_state,
          body,
        },
      }).catch(() => null);
      sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Follow-up send failed";
      await failEnrollmentAttempt(
        enrollment.id,
        message,
        new Date(Date.now() + 15 * 60_000).toISOString()
      );
      failed++;
    }
  }

  return { ...EMPTY, sent, stopped, failed, sent_24h: pace.sent_24h + sent };
}

// Called for every inbound WhatsApp message. A reply is the whole point of the
// follow-up, so it always ends the sequence — and an explicit "stop" ends every
// future one too.
export async function handleFollowUpInbound(chatId: string, body: string): Promise<void> {
  const key = phoneKey(chatIdToPhone(chatId));
  if (key.length < 9) return;
  const optOut = isOptOutReply(body);
  if (optOut) {
    const profile = await getCustomerProfile(key);
    if (profile && !optedOut(profile)) {
      await updateCustomerProfile(key, {
        tags: [...profile.tags, FOLLOW_UP_OPT_OUT_TAG],
      });
    }
  }
  await stopActiveEnrollmentFor(
    key,
    optOut ? STOP_REASON_LABELS.opted_out : STOP_REASON_LABELS.replied
  );
}

// Called when a chat reaches CONFIRMED/SHIPPED or an order is created: the lead
// converted, so nothing further should chase them.
export async function stopFollowUpsForConversion(phone: string): Promise<void> {
  const key = phoneKey(phone);
  if (key.length < 9) return;
  await stopActiveEnrollmentFor(key, STOP_REASON_LABELS.converted);
}
