"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { AgentConfig, AgentMode, AgentRun } from "@/lib/types";
import { Froggy } from "../components/froggy";
import { Button, Card } from "../components/ui";
import { AiStateBadge, RunStatusBadge, fieldClass, timeAgo } from "../components/crm-ui";

const MODE_INFO: Record<AgentMode, { title: string; description: string; icon: string; tone: string }> = {
  off: {
    title: "AI is watching, not replying",
    description: "Customers receive no AI messages. Runs are skipped until you choose Draft or Autonomous.",
    icon: "⏹",
    tone: "!border-cardline bg-surface-soft",
  },
  draft: {
    title: "AI prepares replies for you",
    description: "The agent understands each message and writes a reply, but waits for a human to send it.",
    icon: "✍️",
    tone: "!border-grape bg-grape-tint",
  },
  auto: {
    title: "AI is selling autonomously",
    description: "High-confidence replies are sent after your delay. Complaints, uncertainty and unsafe requests are handed to you.",
    icon: "⚡",
    tone: "!border-frog bg-pond",
  },
};

export default function AiPage() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [configResponse, runsResponse] = await Promise.all([
        fetch("/api/agent/config", { cache: "no-store" }),
        fetch("/api/agent/runs", { cache: "no-store" }),
      ]);
      const configData = await configResponse.json();
      const runsData = await runsResponse.json();
      if (!configResponse.ok) throw new Error(configData.error || "Could not load AI settings");
      if (!runsResponse.ok) throw new Error(runsData.error || "Could not load AI activity");
      setConfig(configData.config);
      setRuns(runsData.runs);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load AI salesperson");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function save() {
    if (!config) return;
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch("/api/agent/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save settings");
      setConfig(data.config);
      setNotice(`✓ Saved — ${data.config.mode === "auto" ? "AI is live" : data.config.mode === "draft" ? "draft mode active" : "AI is off"}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save AI settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">{[100, 180, 460].map((height) => <div key={height} className="animate-pulse rounded-2xl border-2 border-cardline bg-surface-soft" style={{ height }} />)}</main>;
  }

  if (!config) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Card className="py-14 text-center">
          <Froggy mood="sleepy" size={80} bob={false} className="mx-auto" />
          <h1 className="font-display text-xl font-extrabold">AI salesperson unavailable</h1>
          <p className="mt-2 text-sm font-bold text-danger-ink">{error}</p>
          <button onClick={() => void load()} className="mt-4 font-display font-extrabold text-frog-dark underline">Try again</button>
        </Card>
      </main>
    );
  }

  const info = MODE_INFO[config.mode];

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Froggy mood={config.mode === "auto" ? "celebrate" : config.mode === "draft" ? "thinking" : "sleepy"} size={64} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-extrabold text-ink sm:text-3xl">AI Salesperson</h1>
          <p className="text-sm font-bold text-ink-soft">Your always-on WhatsApp teammate.</p>
        </div>
        <AiStateBadge mode={config.mode} />
      </header>

      {error && <Card className="!border-danger-line bg-danger-bg p-4 font-display text-sm font-bold text-danger-ink">⚠️ {error}</Card>}
      {notice && <Card className="!border-frog bg-pond p-4 font-display text-sm font-extrabold text-frog-dark">{notice}</Card>}

      <Card className="overflow-hidden !border-grape">
        <div className="border-b-2 border-grape/30 bg-grape-tint p-4 sm:p-5">
          <p className="font-display text-xs font-extrabold uppercase tracking-widest text-grape-dark">Master control</p>
          <h2 className="mt-1 font-display text-xl font-extrabold text-ink">How much should the AI handle?</h2>
        </div>
        <div className="grid grid-cols-3 gap-2 p-3 sm:gap-4 sm:p-5" role="radiogroup" aria-label="AI operating mode">
          {(["off", "draft", "auto"] as AgentMode[]).map((mode) => {
            const selected = config.mode === mode;
            return (
              <button
                key={mode}
                role="radio"
                aria-checked={selected}
                onClick={() => setConfig({ ...config, mode })}
                className={`rounded-2xl border-2 border-b-4 p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-grape sm:p-4 ${
                  selected ? mode === "auto" ? "border-frog bg-pond" : mode === "draft" ? "border-grape bg-grape-tint" : "border-ink-soft bg-surface-soft" : "border-cardline bg-surface hover:-translate-y-0.5"
                }`}
              >
                <span className="text-xl">{MODE_INFO[mode].icon}</span>
                <span className="mt-2 block font-display text-sm font-extrabold uppercase text-ink sm:text-base">{mode === "auto" ? "Autonomous" : mode}</span>
                <span className="mt-1 hidden text-xs font-bold text-ink-soft sm:block">{mode === "off" ? "No AI replies" : mode === "draft" ? "You approve replies" : "AI sends safely"}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <Card className={`flex items-start gap-4 p-4 ${info.tone} sm:p-5`}>
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-surface text-2xl shadow-sm">{info.icon}</div>
        <div>
          <h2 className="font-display text-lg font-extrabold text-ink">{info.title}</h2>
          <p className="mt-1 max-w-3xl text-sm font-bold leading-relaxed text-ink-soft">{info.description}</p>
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(300px,0.75fr)]">
        <div className="space-y-5">
          <Card className="p-4 sm:p-5">
            <div className="mb-5">
              <h2 className="font-display text-lg font-extrabold text-ink">⚙️ Reply behaviour</h2>
              <p className="text-xs font-bold text-ink-soft">Tune confidence, pacing and sleeping hours.</p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="font-display text-xs font-extrabold text-ink-soft">
                Minimum confidence · <span className="text-grape-dark">{Math.round(config.min_confidence * 100)}%</span>
                <input
                  type="range"
                  min="50"
                  max="99"
                  value={Math.round(config.min_confidence * 100)}
                  onChange={(event) => setConfig({ ...config, min_confidence: Number(event.target.value) / 100 })}
                  className="mt-3 w-full accent-[var(--color-grape)]"
                />
                <span className="mt-1 block font-body text-[11px] font-bold">Below this, the AI asks you to step in.</span>
              </label>
              <label className="font-display text-xs font-extrabold text-ink-soft">
                Human-like reply delay
                <div className="mt-1 flex items-center gap-2">
                  <input type="number" min="1" max="30" className={fieldClass} value={config.reply_delay_seconds} onChange={(event) => setConfig({ ...config, reply_delay_seconds: Number(event.target.value) })} />
                  <span className="font-display text-sm font-extrabold">seconds</span>
                </div>
              </label>
              <label className="font-display text-xs font-extrabold text-ink-soft">
                Quiet hours begin
                <input type="time" className={`${fieldClass} mt-1`} value={config.quiet_hours_start} onChange={(event) => setConfig({ ...config, quiet_hours_start: event.target.value })} />
              </label>
              <label className="font-display text-xs font-extrabold text-ink-soft">
                Quiet hours end
                <input type="time" className={`${fieldClass} mt-1`} value={config.quiet_hours_end} onChange={(event) => setConfig({ ...config, quiet_hours_end: event.target.value })} />
              </label>
            </div>
          </Card>

          <Card className="p-4 sm:p-5">
            <h2 className="font-display text-lg font-extrabold text-ink">🎭 Personality</h2>
            <p className="mb-3 text-xs font-bold text-ink-soft">How the AI should sound in Sinhala, Tamil or English.</p>
            <textarea
              className={`${fieldClass} min-h-32 resize-y`}
              value={config.personality}
              onChange={(event) => setConfig({ ...config, personality: event.target.value })}
              placeholder="Friendly, concise, helpful. Use natural Sri Lankan phrasing..."
            />
          </Card>

          <Card className="p-4 sm:p-5">
            <h2 className="font-display text-lg font-extrabold text-ink">📚 Business knowledge</h2>
            <p className="mb-3 text-xs font-bold text-ink-soft">Products, prices, delivery details and answers the agent can rely on.</p>
            <textarea
              className={`${fieldClass} min-h-52 resize-y`}
              value={config.business_context}
              onChange={(event) => setConfig({ ...config, business_context: event.target.value })}
              placeholder={"Products:\n• Product name — Rs. 2,500\n\nDelivery:\n• COD islandwide\n• 2–4 working days"}
            />
          </Card>

          <div className="sticky bottom-3 z-10 flex justify-end">
            <Button tone={config.mode === "auto" ? "frog" : "grape"} onClick={() => void save()} disabled={saving} className="min-w-44 shadow-xl">
              {saving ? "Saving..." : config.mode === "auto" ? "Save & go live" : "Save AI settings"}
            </Button>
          </div>
        </div>

        <aside className="space-y-5">
          <Card className="overflow-hidden !border-flame">
            <div className="border-b-2 border-flame/30 bg-flame-tint p-4">
              <h2 className="font-display text-lg font-extrabold text-flame-dark">🛡️ Fixed safety rules</h2>
              <p className="text-xs font-bold text-ink-soft">These boundaries cannot be switched off.</p>
            </div>
            <ul className="space-y-3 p-4">
              {[
                "Never invent products, stock or prices",
                "Never offer discounts or refunds",
                "Never dispatch or change an order",
                "Complaints always reach a human",
                "Low-confidence messages are handed off",
              ].map((rule) => <li key={rule} className="flex gap-2 text-sm font-bold text-ink"><span className="text-frog-dark">✓</span>{rule}</li>)}
            </ul>
          </Card>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b-2 border-cardline p-4">
              <div>
                <h2 className="font-display text-lg font-extrabold text-ink">Recent decisions</h2>
                <p className="text-xs font-bold text-ink-soft">Live agent audit</p>
              </div>
              <button onClick={() => void load()} className="rounded-lg px-2 py-1 font-display text-xs font-extrabold text-sky-dark hover:bg-sky-tint">↻</button>
            </div>
            <div className="max-h-[680px] divide-y-2 divide-cardline overflow-y-auto">
              {runs.length === 0 ? (
                <div className="p-8 text-center">
                  <div className="text-3xl">✨</div>
                  <p className="mt-2 text-sm font-bold text-ink-soft">Agent decisions will appear here.</p>
                </div>
              ) : runs.slice(0, 30).map((run) => (
                <article key={run.id} className="p-4">
                  <div className="flex items-center gap-2">
                    <RunStatusBadge status={run.status} />
                    <span className="ml-auto text-[11px] font-bold text-ink-soft">{timeAgo(run.created_at)}</span>
                  </div>
                  <Link href={`/customers/${encodeURIComponent(run.phone_key)}`} className="mt-2 block font-display text-sm font-extrabold text-ink hover:text-grape-dark">
                    {run.phone_key} <span className="text-ink-soft">›</span>
                  </Link>
                  <p className="mt-0.5 text-xs font-bold capitalize text-ink-soft">{run.intent?.replaceAll("_", " ") || "Analysing"} · {Math.round(run.confidence * 100)}%</p>
                  {run.reply && <p className="mt-2 line-clamp-3 rounded-xl bg-grape-tint p-2.5 text-xs font-semibold text-ink">“{run.reply}”</p>}
                  {(run.error || run.decision?.handoff_reason) && <p className="mt-2 text-xs font-bold text-danger-ink">{run.error || run.decision?.handoff_reason}</p>}
                </article>
              ))}
            </div>
          </Card>
        </aside>
      </div>
    </main>
  );
}
