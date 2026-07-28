"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AttentionItem, AttentionStatus } from "@/lib/types";
import { Froggy } from "../components/froggy";
import { Card } from "../components/ui";
import { money, timeAgo } from "../components/crm-ui";

type Feed = { items: AttentionItem[]; counts: Record<string, number>; cod_at_risk: number };
type Filter = "all" | "customers" | "orders" | "delivery" | "system";

const FILTERS: Array<{ key: Filter; label: string; emoji: string }> = [
  { key: "all", label: "All", emoji: "⚡" },
  { key: "customers", label: "Customers", emoji: "💬" },
  { key: "orders", label: "Orders", emoji: "📦" },
  { key: "delivery", label: "Delivery", emoji: "🛵" },
  { key: "system", label: "System", emoji: "⚙️" },
];

const CATEGORY_BY_KIND: Record<AttentionItem["kind"], Exclude<Filter, "all">> = {
  unreplied: "customers",
  stale_address: "customers",
  stale_confirmation: "customers",
  order_ready: "orders",
  delivery_problem: "delivery",
  ai_handoff: "system",
  failed_message: "system",
};

const PRIORITY = {
  urgent: { label: "Urgent", icon: "🔥", shell: "border-flame bg-flame-tint", text: "text-flame-dark" },
  high: { label: "High", icon: "⚡", shell: "border-gold bg-gold/10", text: "text-gold-dark" },
  medium: { label: "Medium", icon: "●", shell: "border-sky bg-sky-tint", text: "text-sky-dark" },
  low: { label: "Low", icon: "●", shell: "border-cardline bg-surface", text: "text-ink-soft" },
} as const;

function oneHourFromNow() {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function humanCopy(item: AttentionItem) {
  if (item.kind === "ai_handoff") {
    return { title: "Customer needs a human reply", summary: "Why it is here: this conversation was handed over for manual review." };
  }
  if (item.kind === "failed_message") {
    return { title: "Message delivery failed", summary: "Why it is here: a customer message could not be sent and needs review." };
  }
  return { title: item.title, summary: item.summary };
}

export default function AttentionPage() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/attention", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load action items");
      setFeed(data);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load Action Queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const visible = useMemo(
    () => feed?.items.filter((item) => filter === "all" || CATEGORY_BY_KIND[item.kind] === filter) ?? [],
    [feed, filter]
  );

  async function update(id: string, status: AttentionStatus) {
    setBusy(id);
    try {
      const response = await fetch(`/api/attention/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(status === "snoozed" ? { status, snoozed_until: oneHourFromNow() } : { status }),
      });
      if (!response.ok) throw new Error("Update failed");
      setFeed((current) => current ? { ...current, items: current.items.filter((item) => item.id !== id) } : current);
    } catch {
      setError("That action could not be updated. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Froggy mood="thinking" size={58} />
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl font-extrabold text-ink sm:text-3xl">Action Queue</h1>
          <p className="text-sm font-bold text-ink-soft">The few things that need a human decision now.</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-xl border-2 border-cardline bg-surface px-4 py-2 font-display text-xs font-extrabold text-ink transition hover:border-grape focus:outline-none focus:ring-2 focus:ring-grape disabled:opacity-50"
        >
          ↻ Refresh
        </button>
      </header>

      {error && (
        <Card className="flex flex-wrap items-center justify-between gap-3 !border-danger-line bg-danger-bg p-4">
          <p className="font-display text-sm font-bold text-danger-ink">⚠️ {error}</p>
          <button type="button" className="font-display text-sm font-extrabold text-danger-ink underline" onClick={() => void load()}>Try again</button>
        </Card>
      )}

      <section className="grid grid-cols-3 gap-2 sm:gap-4" aria-label="Action queue summary">
        {[
          ["🔥", error ? "—" : (feed?.counts.urgent ?? 0), "Urgent now", "text-flame-dark", "!border-flame"],
          ["⚡", error ? "—" : (feed?.counts.all ?? 0), "Open actions", "text-grape-dark", "!border-grape"],
          ["💰", error ? "—" : money(feed?.cod_at_risk ?? 0), "Exact order COD", "text-gold-dark", "!border-gold"],
        ].map(([icon, value, label, text, border]) => (
          <Card key={label} className={`min-w-0 p-3 sm:p-5 ${border}`}>
            <div className="mb-1 text-lg">{icon}</div>
            <div className={`truncate font-display text-xl font-extrabold sm:text-3xl ${text}`}>{value}</div>
            <div className="font-display text-[10px] font-bold uppercase tracking-wide text-ink-soft sm:text-xs">{label}</div>
          </Card>
        ))}
      </section>

      <div className="flex flex-wrap gap-2" aria-label="Action categories">
        {FILTERS.map((item) => (
          <button
            type="button"
            key={item.key}
            onClick={() => setFilter(item.key)}
            className={`shrink-0 rounded-xl border-2 px-3 py-2 font-display text-xs font-extrabold transition focus:outline-none focus:ring-2 focus:ring-grape ${
              filter === item.key ? "border-grape bg-grape-tint text-grape-dark" : "border-cardline bg-surface text-ink-soft hover:border-grape"
            }`}
          >
            {item.emoji} {item.label} · {feed?.counts[item.key] ?? 0}
          </button>
        ))}
      </div>

      {error ? null : loading ? (
        <div className="space-y-3" aria-label="Loading action items">
          {[0, 1].map((item) => (
            <div key={item} className="h-24 animate-pulse rounded-2xl border-2 border-cardline bg-surface p-4">
              <span className="block h-2 w-20 rounded bg-surface-soft" />
              <span className="mt-3 block h-4 w-64 max-w-full rounded bg-surface-soft" />
              <span className="mt-2 block h-2 w-full max-w-md rounded bg-surface-soft" />
            </div>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card className="py-14 text-center">
          <Froggy mood="happy" size={80} bob={false} className="mx-auto" />
          <h2 className="mt-2 font-display text-xl font-extrabold text-ink">The queue is clear</h2>
          <p className="mt-1 text-sm font-bold text-ink-soft">
            {filter === "all" ? "There are no open actions right now." : `There are no open ${filter} actions.`}
          </p>
        </Card>
      ) : (
        <section className="space-y-3" aria-label="Action items">
          {visible.map((item) => {
            const style = PRIORITY[item.priority];
            const customer = item.customer;
            const copy = humanCopy(item);
            const itemCod = Number(item.payload.total_cod);
            const category = CATEGORY_BY_KIND[item.kind];
            const primaryHref =
              category === "orders" || category === "delivery"
                ? "/orders"
                : item.chat_id
                  ? `/?chat=${encodeURIComponent(item.chat_id)}`
                  : customer
                    ? `/customers/${encodeURIComponent(customer.phone_key)}`
                    : null;
            const primaryLabel =
              category === "orders" ? "Review order" : category === "delivery" ? "Review delivery" : item.chat_id ? "Open chat" : "View customer";
            return (
              <Card key={item.id} className={`overflow-hidden !border-l-[7px] ${style.shell}`}>
                <div className="grid gap-4 p-4 sm:grid-cols-[1fr_auto] sm:p-5">
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap items-center gap-2">
                      <span className={`font-display text-[10px] font-extrabold uppercase tracking-wider ${style.text}`}>{style.icon} {style.label}</span>
                      <span className="text-xs font-bold text-ink-soft">Created {timeAgo(item.created_at)}</span>
                      <span className="text-xs font-bold text-ink-soft">· Due {timeAgo(item.due_at ?? item.created_at)}</span>
                    </div>
                    <h2 className="font-display text-lg font-extrabold text-ink">{copy.title}</h2>
                    <p className="mt-1 text-sm font-semibold text-ink-soft">{copy.summary}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-ink-soft">
                      {customer && <><span>👤 {customer.display_name}</span><span>{customer.primary_phone}</span></>}
                      {typeof item.payload.order_no === "string" && <span>📦 {item.payload.order_no}</span>}
                      {Number.isFinite(itemCod) && itemCod > 0 && <span className="text-gold-dark">COD at risk {money(itemCod)}</span>}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 sm:w-48 sm:flex-col">
                    {primaryHref && <Link href={primaryHref} className="btn3d flex-1 border-grape-dark bg-grape px-3 text-center text-white">{primaryLabel}</Link>}
                    <button type="button" disabled={busy === item.id} onClick={() => void update(item.id, "resolved")} className="flex-1 rounded-xl border-2 border-frog bg-pond px-3 py-2 font-display text-xs font-extrabold text-frog-dark focus:outline-none focus:ring-2 focus:ring-frog disabled:opacity-50">Mark resolved</button>
                    <button type="button" disabled={busy === item.id} onClick={() => void update(item.id, "snoozed")} className="flex-1 rounded-xl border-2 border-cardline bg-surface px-3 py-2 font-display text-xs font-extrabold text-ink-soft focus:outline-none focus:ring-2 focus:ring-grape disabled:opacity-50">Snooze 1 hour</button>
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
