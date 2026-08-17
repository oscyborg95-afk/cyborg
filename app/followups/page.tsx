"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  FollowUpEnrollment,
  FollowUpSend,
  FollowUpSequence,
  FollowUpSettings,
} from "@/lib/types";
import { Froggy } from "../components/froggy";
import { Button, Card } from "../components/ui";
import { fieldClass, timeAgo } from "../components/crm-ui";

const SEQUENCE_INFO: Record<string, { title: string; blurb: string; icon: string }> = {
  AWAITING_ADDRESS: {
    title: "Waiting on an address",
    blurb: "They showed interest but never sent name / address / phone.",
    icon: "📍",
  },
  AWAITING_CONFIRMATION: {
    title: "Waiting on a COD confirmation",
    blurb: "They reached the total but never replied OK.",
    icon: "💰",
  },
  NEW: {
    title: "Never answered at all",
    blurb: "They messaged once and went quiet. Off by default — this is the pushiest one.",
    icon: "👋",
  },
};

type EnrollmentRow = FollowUpEnrollment & { display_name: string };

export default function FollowUpsPage() {
  const [settings, setSettings] = useState<FollowUpSettings | null>(null);
  const [enrollments, setEnrollments] = useState<EnrollmentRow[]>([]);
  const [sends, setSends] = useState<FollowUpSend[]>([]);
  const [pace, setPace] = useState<{ sent_24h: number; last_sent_at: string | null }>({
    sent_24h: 0,
    last_sent_at: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/followups", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load follow-ups");
      setSettings(data.settings);
      setEnrollments(data.enrollments);
      setSends(data.sends);
      setPace(data.pace);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load follow-ups");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function save(overrides: Partial<FollowUpSettings> = {}) {
    if (!settings) return;
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/followups", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, ...overrides }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save follow-ups");
      setSettings(data.settings);
      setNotice(
        data.settings.enabled
          ? "✓ Saved — follow-ups are live"
          : "✓ Saved — follow-ups are paused"
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save follow-ups");
    } finally {
      setSaving(false);
    }
  }

  async function stopEnrollment(id: string) {
    setError("");
    try {
      const response = await fetch(`/api/followups/enrollments/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not stop this follow-up");
      setEnrollments((current) =>
        current.map((row) =>
          row.id === id ? { ...row, status: "stopped", stop_reason: "Stopped by operator" } : row
        )
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not stop this follow-up");
    }
  }

  function updateSequence(index: number, next: FollowUpSequence) {
    if (!settings) return;
    const sequences = settings.sequences.map((s, i) => (i === index ? next : s));
    setSettings({ ...settings, sequences });
  }

  if (loading) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Card className="py-14 text-center">
          <Froggy mood="thinking" size={80} bob={false} className="mx-auto" />
          <h1 className="font-display text-xl font-extrabold">Loading follow-ups…</h1>
        </Card>
      </main>
    );
  }

  if (!settings) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Card className="py-14 text-center">
          <Froggy mood="sleepy" size={80} bob={false} className="mx-auto" />
          <h1 className="font-display text-xl font-extrabold">Follow-ups unavailable</h1>
          <p className="mt-2 text-sm font-bold text-danger-ink">{error}</p>
          <button
            onClick={() => void load()}
            className="mt-4 font-display font-extrabold text-frog-dark underline"
          >
            Try again
          </button>
        </Card>
      </main>
    );
  }

  const active = enrollments.filter((e) => e.status === "active");
  const capLeft = Math.max(0, settings.daily_cap - pace.sent_24h);

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Froggy mood={settings.enabled ? "celebrate" : "sleepy"} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-extrabold text-ink sm:text-3xl">
            Auto Follow-ups
          </h1>
          <p className="text-sm font-bold text-ink-soft">
            Chases the leads who went quiet, one message at a time.
          </p>
        </div>
        <span
          className={`rounded-xl border-2 px-3 py-1.5 font-display text-xs font-extrabold uppercase ${
            settings.enabled
              ? "border-frog bg-pond text-frog-dark"
              : "border-cardline bg-surface-soft text-ink-soft"
          }`}
        >
          {settings.enabled ? "● Live" : "Paused"}
        </span>
      </header>

      {error && (
        <Card className="!border-danger-line bg-danger-bg p-4 font-display text-sm font-bold text-danger-ink">
          ⚠️ {error}
        </Card>
      )}
      {notice && (
        <Card className="!border-frog bg-pond p-4 font-display text-sm font-extrabold text-frog-dark">
          {notice}
        </Card>
      )}

      <Card className="overflow-hidden !border-grape">
        <div className="border-b-2 border-grape/30 bg-grape-tint p-4 sm:p-5">
          <p className="font-display text-xs font-extrabold uppercase tracking-widest text-grape-dark">
            Master switch
          </p>
          <h2 className="mt-1 font-display text-xl font-extrabold text-ink">
            {settings.enabled
              ? "Cold leads are being followed up automatically"
              : "Follow-ups are paused — nothing is being sent"}
          </h2>
          <p className="mt-1 max-w-3xl text-sm font-bold text-ink-soft">
            Messages go out one at a time with a gap between them. Anyone who replies, orders, or
            says stop leaves the queue immediately.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <Button
            tone={settings.enabled ? "ghost" : "frog"}
            disabled={saving}
            onClick={() => void save({ enabled: !settings.enabled })}
          >
            {settings.enabled ? "⏸ Pause follow-ups" : "▶ Turn follow-ups on"}
          </Button>
          <span className="font-display text-xs font-bold text-ink-soft">
            Last sent {timeAgo(pace.last_sent_at)}
          </span>
        </div>
      </Card>

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "In the queue", value: active.length, detail: "leads being chased" },
          { label: "Sent (24h)", value: pace.sent_24h, detail: `${capLeft} left today` },
          { label: "Daily cap", value: settings.daily_cap, detail: "hard limit" },
        ].map((metric) => (
          <Card key={metric.label} className="p-3 text-center sm:p-4">
            <p className="font-display text-xl font-extrabold text-ink sm:text-2xl">
              {metric.value}
            </p>
            <p className="text-[11px] font-extrabold uppercase text-ink-soft">{metric.label}</p>
            <p className="mt-1 hidden text-[10px] font-semibold text-ink-soft sm:block">
              {metric.detail}
            </p>
          </Card>
        ))}
      </div>

      <Card className="p-4 sm:p-5">
        <h2 className="font-display text-lg font-extrabold text-ink">🛡️ Safety limits</h2>
        <p className="mb-4 text-xs font-bold text-ink-soft">
          This runs on your own WhatsApp number. Keeping the volume low and the gaps human is what
          keeps the number safe — raise these slowly.
        </p>
        <div className="grid gap-4 sm:grid-cols-4">
          <label className="font-display text-xs font-extrabold text-ink-soft">
            Max per day
            <input
              type="number"
              min="1"
              max="200"
              className={`${fieldClass} mt-1`}
              value={settings.daily_cap}
              onChange={(event) =>
                setSettings({ ...settings, daily_cap: Number(event.target.value) })
              }
            />
          </label>
          <label className="font-display text-xs font-extrabold text-ink-soft">
            Gap between sends
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min="1"
                max="120"
                className={fieldClass}
                value={settings.min_gap_minutes}
                onChange={(event) =>
                  setSettings({ ...settings, min_gap_minutes: Number(event.target.value) })
                }
              />
              <span className="font-display text-sm font-extrabold">min</span>
            </div>
          </label>
          <label className="font-display text-xs font-extrabold text-ink-soft">
            Send from
            <input
              type="time"
              className={`${fieldClass} mt-1`}
              value={settings.window_start}
              onChange={(event) => setSettings({ ...settings, window_start: event.target.value })}
            />
          </label>
          <label className="font-display text-xs font-extrabold text-ink-soft">
            Send until
            <input
              type="time"
              className={`${fieldClass} mt-1`}
              value={settings.window_end}
              onChange={(event) => setSettings({ ...settings, window_end: event.target.value })}
            />
          </label>
        </div>
      </Card>

      {settings.sequences.map((sequence, index) => {
        const info = SEQUENCE_INFO[sequence.trigger_state] ?? {
          title: sequence.trigger_state,
          blurb: "",
          icon: "🔔",
        };
        return (
          <Card key={sequence.trigger_state} className="p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-start gap-3">
              <span className="text-2xl" aria-hidden>
                {info.icon}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-lg font-extrabold text-ink">{info.title}</h2>
                <p className="text-xs font-bold text-ink-soft">{info.blurb}</p>
              </div>
              <label className="flex items-center gap-2 font-display text-xs font-extrabold text-ink-soft">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--color-frog)]"
                  checked={sequence.enabled}
                  onChange={(event) =>
                    updateSequence(index, { ...sequence, enabled: event.target.checked })
                  }
                />
                {sequence.enabled ? "On" : "Off"}
              </label>
            </div>

            <div className="space-y-4">
              {sequence.steps.map((step, stepIndex) => (
                <div
                  key={stepIndex}
                  className="rounded-2xl border-2 border-cardline bg-surface-soft p-3 sm:p-4"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-3">
                    <span className="rounded-lg bg-surface px-2 py-1 font-display text-[11px] font-extrabold uppercase text-ink-soft">
                      Step {stepIndex + 1}
                    </span>
                    <label className="flex items-center gap-2 font-display text-xs font-extrabold text-ink-soft">
                      Send after
                      <input
                        type="number"
                        min="1"
                        max="720"
                        className={`${fieldClass} w-20`}
                        value={step.delay_hours}
                        onChange={(event) => {
                          const steps = sequence.steps.map((s, i) =>
                            i === stepIndex
                              ? { ...s, delay_hours: Number(event.target.value) }
                              : s
                          );
                          updateSequence(index, { ...sequence, steps });
                        }}
                      />
                      hours {stepIndex === 0 ? "of silence" : "after the previous one"}
                    </label>
                  </div>
                  <p className="mb-2 text-[11px] font-bold text-ink-soft">
                    One of these is picked per customer, so no two people get identical text. Use{" "}
                    <code className="rounded bg-surface px-1">{"{{name}}"}</code> and{" "}
                    <code className="rounded bg-surface px-1">{"{{business}}"}</code>.
                  </p>
                  <div className="space-y-2">
                    {step.variants.map((variant, variantIndex) => (
                      <div key={variantIndex} className="flex items-start gap-2">
                        <textarea
                          className={`${fieldClass} min-h-24 flex-1 resize-y`}
                          value={variant}
                          onChange={(event) => {
                            const variants = step.variants.map((v, i) =>
                              i === variantIndex ? event.target.value : v
                            );
                            const steps = sequence.steps.map((s, i) =>
                              i === stepIndex ? { ...s, variants } : s
                            );
                            updateSequence(index, { ...sequence, steps });
                          }}
                        />
                        {step.variants.length > 1 && (
                          <button
                            type="button"
                            aria-label="Remove this wording"
                            onClick={() => {
                              const variants = step.variants.filter((_, i) => i !== variantIndex);
                              const steps = sequence.steps.map((s, i) =>
                                i === stepIndex ? { ...s, variants } : s
                              );
                              updateSequence(index, { ...sequence, steps });
                            }}
                            className="rounded-xl border-2 border-cardline px-2 py-1 font-display text-xs font-extrabold text-ink-soft hover:bg-danger-bg hover:text-danger-ink"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const steps = sequence.steps.map((s, i) =>
                        i === stepIndex ? { ...s, variants: [...s.variants, ""] } : s
                      );
                      updateSequence(index, { ...sequence, steps });
                    }}
                    className="mt-2 font-display text-xs font-extrabold text-frog-dark underline"
                  >
                    + Add another wording
                  </button>
                </div>
              ))}
            </div>
          </Card>
        );
      })}

      <div className="sticky bottom-4 z-10 flex justify-end">
        <Button disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "💾 Save follow-up messages"}
        </Button>
      </div>

      <Card className="p-4 sm:p-5">
        <h2 className="font-display text-lg font-extrabold text-ink">
          🎯 In the queue ({active.length})
        </h2>
        <p className="mb-3 text-xs font-bold text-ink-soft">
          Leads waiting for their next nudge. Stop any of them if you have already handled it.
        </p>
        {active.length === 0 ? (
          <p className="py-6 text-center font-display text-sm font-bold text-ink-soft">
            Nobody is cold right now 🎉
          </p>
        ) : (
          <ul className="space-y-2">
            {active.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-3 rounded-2xl border-2 border-cardline bg-surface-soft p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-display text-sm font-extrabold text-ink">
                    {row.display_name || row.phone_key}
                  </p>
                  <p className="text-[11px] font-bold text-ink-soft">
                    {SEQUENCE_INFO[row.trigger_state]?.title ?? row.trigger_state} · step{" "}
                    {row.step_index + 1} · next {timeAgo(row.next_run_at)}
                    {row.last_error ? ` · ⚠️ ${row.last_error}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void stopEnrollment(row.id)}
                  className="rounded-xl border-2 border-cardline px-3 py-1.5 font-display text-xs font-extrabold text-ink-soft hover:bg-danger-bg hover:text-danger-ink"
                >
                  Stop
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4 sm:p-5">
        <h2 className="font-display text-lg font-extrabold text-ink">📤 Recently sent</h2>
        <p className="mb-3 text-xs font-bold text-ink-soft">
          Exactly what went out, so nothing is a surprise.
        </p>
        {sends.length === 0 ? (
          <p className="py-6 text-center font-display text-sm font-bold text-ink-soft">
            Nothing sent yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {sends.map((send) => (
              <li key={send.id} className="rounded-2xl border-2 border-cardline bg-surface-soft p-3">
                <p className="font-display text-[11px] font-extrabold uppercase text-ink-soft">
                  {send.phone_key} · step {send.step_index + 1} · {timeAgo(send.sent_at)}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-ink">
                  {send.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
