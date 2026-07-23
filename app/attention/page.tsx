"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentConfig, AttentionItem, AttentionKind, AttentionStatus } from "@/lib/types";
import { Froggy } from "../components/froggy";
import { Button, Card } from "../components/ui";
import { AiStateBadge, money, timeAgo } from "../components/crm-ui";

type Feed = { items: AttentionItem[]; counts: Record<string, number>; estimated_value: number };
type Filter = "all" | "leads" | "orders" | "delivery" | "ai";

const FILTERS: { key: Filter; label: string; emoji: string; kinds?: AttentionKind[] }[] = [
  { key: "all", label: "All", emoji: "⚡" },
  { key: "leads", label: "Leads", emoji: "💬", kinds: ["unreplied", "stale_address", "stale_confirmation"] },
  { key: "orders", label: "Ready orders", emoji: "📦", kinds: ["order_ready"] },
  { key: "delivery", label: "Delivery", emoji: "🛵", kinds: ["delivery_problem"] },
  { key: "ai", label: "AI", emoji: "✨", kinds: ["ai_handoff", "failed_message"] },
];

const PRIORITY = {
  urgent: { label: "URGENT", icon: "🔥", shell: "border-flame bg-flame-tint", text: "text-flame-dark" },
  high: { label: "HIGH", icon: "⚡", shell: "border-gold bg-gold/10", text: "text-gold-dark" },
  medium: { label: "MEDIUM", icon: "●", shell: "border-sky bg-sky-tint", text: "text-sky-dark" },
  low: { label: "LOW", icon: "●", shell: "border-cardline bg-surface", text: "text-ink-soft" },
} as const;

function oneHourFromNow(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

export default function AttentionPage() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [mode, setMode] = useState<AgentConfig["mode"]>("off");
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [attentionRes, configRes] = await Promise.all([
        fetch("/api/attention", { cache: "no-store" }),
        fetch("/api/agent/config", { cache: "no-store" }),
      ]);
      const attention = await attentionRes.json();
      const config = await configRes.json();
      if (!attentionRes.ok) throw new Error(attention.error || "Could not load attention items");
      setFeed(attention);
      setError("");
      if (configRes.ok) setMode(config.config.mode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Attention Center");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!feed) return [];
    const selected = FILTERS.find((item) => item.key === filter);
    return selected?.kinds ? feed.items.filter((item) => selected.kinds?.includes(item.kind)) : feed.items;
  }, [feed, filter]);

  async function update(id: string, status: AttentionStatus) {
    setBusy(id);
    try {
      const body = status === "snoozed"
        ? { status, snoozed_until: oneHourFromNow() }
        : { status };
      const response = await fetch(`/api/attention/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Update failed");
      setFeed((current) => current ? { ...current, items: current.items.filter((item) => item.id !== id) } : current);
    } catch {
      setError("That item could not be updated. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Froggy mood={mode === "auto" ? "happy" : "thinking"} size={60} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-extrabold text-ink sm:text-3xl">Attention Center</h1>
          <p className="text-sm font-bold text-ink-soft">Your highest-value next moves, ranked.</p>
        </div>
        <AiStateBadge mode={mode} />
        <Button tone="ghost" onClick={() => void load()} disabled={loading} aria-label="Refresh Attention Center">
          ↻ <span className="hidden sm:inline">Refresh</span>
        </Button>
      </header>

      {error && (
        <Card className="flex flex-wrap items-center justify-between gap-3 !border-danger-line bg-danger-bg p-4">
          <p className="font-display text-sm font-bold text-danger-ink">⚠️ {error}</p>
          <button className="font-display text-sm font-extrabold text-danger-ink underline" onClick={() => void load()}>Try again</button>
        </Card>
      )}

      <section className="grid grid-cols-3 gap-2 sm:gap-4" aria-label="Attention summary">
        {[
          ["🔥", feed?.counts.urgent ?? 0, "Urgent now", "text-flame-dark", "!border-flame"],
          ["⚡", feed?.counts.all ?? 0, "Open moves", "text-grape-dark", "!border-grape"],
          ["💰", money(feed?.estimated_value ?? 0), "Recoverable", "text-frog-dark", "!border-frog"],
        ].map(([icon, value, label, text, border]) => (
          <Card key={label} className={`min-w-0 p-3 sm:p-5 ${border}`}>
            <div className="mb-1 text-lg">{icon}</div>
            <div className={`truncate font-display text-xl font-extrabold sm:text-3xl ${text}`}>{value}</div>
            <div className="font-display text-[10px] font-bold uppercase tracking-wide text-ink-soft sm:text-xs">{label}</div>
          </Card>
        ))}
      </section>

      <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]" aria-label="Attention filters">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            onClick={() => setFilter(item.key)}
            className={`shrink-0 rounded-xl border-2 px-3 py-2 font-display text-xs font-extrabold transition focus:outline-none focus:ring-2 focus:ring-frog ${
              filter === item.key ? "border-grape bg-grape-tint text-grape-dark" : "border-cardline bg-surface text-ink-soft hover:border-grape"
            }`}
          >
            {item.emoji} {item.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3" aria-label="Loading attention items">
          {[0, 1, 2].map((item) => <div key={item} className="h-40 animate-pulse rounded-2xl border-2 border-cardline bg-surface-soft" />)}
        </div>
      ) : visible.length === 0 ? (
        <Card className="py-14 text-center">
          <Froggy mood="happy" size={80} bob={false} className="mx-auto" />
          <h2 className="mt-2 font-display text-xl font-extrabold text-ink">You&apos;re all caught up!</h2>
          <p className="mt-1 text-sm font-bold text-ink-soft">The AI is watching the shop. New opportunities will appear here.</p>
        </Card>
      ) : (
        <section className="space-y-3" aria-label="Ranked attention items">
          {visible.map((item, index) => {
            const style = PRIORITY[item.priority];
            const customer = item.customer;
            return (
              <Card key={item.id} className={`overflow-hidden !border-l-[7px] ${style.shell}`}>
                <div className="grid gap-4 p-4 sm:grid-cols-[48px_1fr_auto] sm:p-5">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface font-display text-xl font-extrabold shadow-sm">
                    {index + 1}
                  </div>
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className={`font-display text-[10px] font-extrabold tracking-wider ${style.text}`}>{style.icon} {style.label}</span>
                      <span className="text-xs font-bold text-ink-soft">{timeAgo(item.due_at ?? item.created_at)}</span>
                    </div>
                    <h2 className="font-display text-lg font-extrabold text-ink">{item.title}</h2>
                    <p className="mt-1 text-sm font-semibold text-ink-soft">{item.summary}</p>
                    {customer && (
                      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-ink-soft">
                        <span>👤 {customer.display_name}</span>
                        <span>{customer.primary_phone}</span>
                        {customer.lifetime_revenue > 0 && <span className="text-frog-dark">{money(customer.lifetime_revenue)} lifetime</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-row flex-wrap gap-2 sm:w-48 sm:flex-col">
                    {item.chat_id && (
                      <Link href={`/?chat=${encodeURIComponent(item.chat_id)}`} className="btn3d flex-1 border-grape-dark bg-grape px-3 text-center text-white">
                        💬 Open chat
                      </Link>
                    )}
                    {customer && (
                      <Link href={`/customers/${encodeURIComponent(customer.phone_key)}`} className="flex-1 rounded-xl border-2 border-cardline bg-surface px-3 py-2 text-center font-display text-xs font-extrabold text-ink hover:border-frog">
                        View customer
                      </Link>
                    )}
                    <div className="flex flex-1 gap-2">
                      <button disabled={busy === item.id} onClick={() => void update(item.id, "resolved")} className="flex-1 rounded-xl border-2 border-cardline bg-surface px-2 py-2 font-display text-xs font-extrabold text-frog-dark disabled:opacity-50">✓ Done</button>
                      <button disabled={busy === item.id} onClick={() => void update(item.id, "snoozed")} className="flex-1 rounded-xl border-2 border-cardline bg-surface px-2 py-2 font-display text-xs font-extrabold text-ink-soft disabled:opacity-50">1h 💤</button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </section>
      )}
    </main>
  );
}
