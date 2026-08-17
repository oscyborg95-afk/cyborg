import assert from "node:assert/strict";
import test from "node:test";
import {
  coldSince,
  dispatchBlockReason,
  insideSendWindow,
  isOptOutReply,
  pickVariant,
  renderFollowUp,
  sequenceFor,
  shouldEnroll,
  stopReasonFor,
} from "../lib/followup-policy.ts";

const SETTINGS = {
  window_start: "09:00",
  window_end: "20:00",
  sequences: [
    {
      trigger_state: "AWAITING_ADDRESS",
      enabled: true,
      steps: [
        { delay_hours: 4, label: "Nudge", variants: ["one", "two", "three"] },
        { delay_hours: 24, label: "Second", variants: ["later"] },
      ],
    },
    {
      trigger_state: "NEW",
      enabled: false,
      steps: [{ delay_hours: 6, label: "Reopen", variants: ["hello"] }],
    },
  ],
};

test("the send window is evaluated in Colombo time", () => {
  // 12:30 and 03:30 in Asia/Colombo.
  assert.equal(insideSendWindow(SETTINGS, new Date("2026-07-22T07:00:00Z")), true);
  assert.equal(insideSendWindow(SETTINGS, new Date("2026-07-21T22:00:00Z")), false);
});

test("an empty window is treated as always open, not always shut", () => {
  assert.equal(
    insideSendWindow({ window_start: "00:00", window_end: "00:00" }, new Date()),
    true
  );
});

test("a disabled sequence never produces enrollments", () => {
  const now = Date.parse("2026-07-22T12:00:00Z");
  assert.equal(
    shouldEnroll(
      SETTINGS,
      {
        phone_key: "768846320",
        chat_id: "94768846320@s.whatsapp.net",
        trigger_state: "NEW",
        last_inbound_at: "2026-07-20T12:00:00Z",
        state_updated_at: "2026-07-20T12:00:00Z",
      },
      now
    ),
    false
  );
});

test("enrollment waits for the first step's silence to actually elapse", () => {
  const now = Date.parse("2026-07-22T12:00:00Z");
  const candidate = (lastInbound) => ({
    phone_key: "768846320",
    chat_id: "94768846320@s.whatsapp.net",
    trigger_state: "AWAITING_ADDRESS",
    last_inbound_at: lastInbound,
    state_updated_at: "2026-07-22T05:00:00Z",
  });
  // Three hours of silence against a four-hour first step.
  assert.equal(shouldEnroll(SETTINGS, candidate("2026-07-22T09:00:00Z"), now), false);
  assert.equal(shouldEnroll(SETTINGS, candidate("2026-07-22T07:00:00Z"), now), true);
});

test("silence is measured from the customer's own last message", () => {
  // With no inbound record at all, the chat-state timestamp stands in.
  assert.equal(
    coldSince({
      phone_key: "768846320",
      chat_id: "x",
      trigger_state: "AWAITING_ADDRESS",
      last_inbound_at: null,
      state_updated_at: "2026-07-22T05:00:00Z",
    }),
    Date.parse("2026-07-22T05:00:00Z")
  );
});

test("a reply after the baseline stops the sequence", () => {
  const base = {
    baseline_inbound_at: "2026-07-22T05:00:00Z",
    enrolled_at: "2026-07-22T09:00:00Z",
    chat_state: "AWAITING_ADDRESS",
    has_order: false,
    opted_out: false,
    ai_enabled: true,
  };
  assert.equal(stopReasonFor({ ...base, last_inbound_at: "2026-07-22T05:00:00Z" }), null);
  assert.equal(stopReasonFor({ ...base, last_inbound_at: "2026-07-22T10:00:00Z" }), "replied");
});

test("a lead who never wrote before enrolling counts any later message as a reply", () => {
  const base = {
    baseline_inbound_at: null,
    enrolled_at: "2026-07-22T09:00:00Z",
    chat_state: "NEW",
    has_order: false,
    opted_out: false,
    ai_enabled: true,
  };
  assert.equal(stopReasonFor({ ...base, last_inbound_at: "2026-07-22T08:00:00Z" }), null);
  assert.equal(stopReasonFor({ ...base, last_inbound_at: "2026-07-22T09:30:00Z" }), "replied");
});

test("conversion and opt-out outrank everything else", () => {
  const base = {
    baseline_inbound_at: null,
    enrolled_at: "2026-07-22T09:00:00Z",
    last_inbound_at: null,
    chat_state: "AWAITING_ADDRESS",
    has_order: false,
    opted_out: false,
    ai_enabled: true,
  };
  assert.equal(stopReasonFor({ ...base, has_order: true }), "converted");
  assert.equal(stopReasonFor({ ...base, chat_state: "CONFIRMED" }), "converted");
  assert.equal(stopReasonFor({ ...base, chat_state: "SHIPPED" }), "converted");
  assert.equal(stopReasonFor({ ...base, opted_out: true }), "opted_out");
  assert.equal(stopReasonFor({ ...base, ai_enabled: false }), "ai_disabled");
});

test("opt-out is recognised in Sinhala, Singlish and English", () => {
  assert.equal(isOptOutReply("STOP"), true);
  assert.equal(isOptOutReply("එපා"), true);
  assert.equal(isOptOutReply("message එවන්න එපා"), true);
  assert.equal(isOptOutReply("epa"), true);
  assert.equal(isOptOutReply("don't message me again"), true);
  // Ordinary replies must not be mistaken for an opt-out.
  assert.equal(isOptOutReply("ok"), false);
  assert.equal(isOptOutReply("mata one"), false);
  assert.equal(isOptOutReply(""), false);
});

test("variant choice is stable per lead but spread across leads", () => {
  const variants = ["one", "two", "three"];
  assert.equal(pickVariant(variants, "768846320", 0), pickVariant(variants, "768846320", 0));
  const chosen = new Set(
    ["768846320", "771234567", "112223334", "701112223", "765554443"].map((key) =>
      pickVariant(variants, key, 0)
    )
  );
  assert.ok(chosen.size > 1, "different leads should not all get the same wording");
  assert.equal(pickVariant([], "768846320", 0), "");
  assert.equal(pickVariant(["  ", "only"], "768846320", 0), "only");
});

test("rendering fills placeholders and survives a missing name", () => {
  assert.equal(
    renderFollowUp("Hi {{name}}, {{business}} here", { name: "Nimal Perera", business: "Daily Cart" }),
    "Hi Nimal, Daily Cart here"
  );
  // An unknown customer must not be greeted with a gap or a stray double space.
  assert.equal(renderFollowUp("Hi {{name}}, thanks", { name: "" }), "Hi , thanks");
  assert.equal(renderFollowUp("{{business}} here", {}), "Our shop here");
});

test("only enabled sequences are resolvable", () => {
  assert.equal(sequenceFor(SETTINGS, "AWAITING_ADDRESS")?.steps.length, 2);
  assert.equal(sequenceFor(SETTINGS, "NEW"), null);
  assert.equal(sequenceFor(SETTINGS, "CONFIRMED"), null);
});

test("the pacing gate blocks on window, cap and gap in that order", () => {
  const limits = { ...SETTINGS, daily_cap: 40, min_gap_minutes: 5 };
  const noon = new Date("2026-07-22T07:00:00Z"); // 12:30 Colombo
  const night = new Date("2026-07-21T22:00:00Z"); // 03:30 Colombo
  const clear = { sent_24h: 0, last_sent_at: null };

  assert.equal(dispatchBlockReason(limits, false, clear, noon), null);
  assert.equal(dispatchBlockReason(limits, false, clear, night), "outside_window");
  // Quiet hours veto a send even when the window says it is fine.
  assert.equal(dispatchBlockReason(limits, true, clear, noon), "quiet_hours");
  assert.equal(
    dispatchBlockReason(limits, false, { sent_24h: 40, last_sent_at: null }, noon),
    "daily_cap"
  );
  assert.equal(
    dispatchBlockReason(limits, false, { sent_24h: 39, last_sent_at: null }, noon),
    null
  );
});

test("the minimum gap is enforced from the last send, not the last tick", () => {
  const limits = { ...SETTINGS, daily_cap: 40, min_gap_minutes: 5 };
  const now = new Date("2026-07-22T07:00:00Z");
  const ago = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
  assert.equal(
    dispatchBlockReason(limits, false, { sent_24h: 1, last_sent_at: ago(2) }, now),
    "min_gap"
  );
  assert.equal(
    dispatchBlockReason(limits, false, { sent_24h: 1, last_sent_at: ago(6) }, now),
    null
  );
});
