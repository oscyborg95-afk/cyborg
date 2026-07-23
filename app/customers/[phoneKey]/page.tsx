"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentRun,
  CustomerEvent,
  CustomerLanguage,
  CustomerSummary,
  Order,
  WaMessage,
} from "@/lib/types";
import { Froggy } from "../../components/froggy";
import { Button, Card } from "../../components/ui";
import {
  AiStateBadge,
  RunStatusBadge,
  StageBadge,
  fieldClass,
  languageName,
  money,
  timeAgo,
} from "../../components/crm-ui";

interface Detail {
  customer: CustomerSummary;
  orders: Order[];
  messages: WaMessage[];
  events: CustomerEvent[];
  agent_runs: AgentRun[];
}

type Form = {
  display_name: string;
  preferred_language: CustomerLanguage;
  tags: string;
  notes: string;
  ai_enabled: boolean;
  ai_paused_until: string | null;
};

function oneDayFromNow(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

export default function CustomerDetailPage() {
  const { phoneKey } = useParams<{ phoneKey: string }>();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [mountedAt] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/customers/${encodeURIComponent(phoneKey)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load customer");
      setDetail(data);
      setError("");
      setForm({
        display_name: data.customer.display_name,
        preferred_language: data.customer.preferred_language,
        tags: data.customer.tags.join(", "),
        notes: data.customer.notes,
        ai_enabled: data.customer.ai_enabled,
        ai_paused_until: data.customer.ai_paused_until,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load customer");
    } finally {
      setLoading(false);
    }
  }, [phoneKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const isPaused = Boolean(form?.ai_paused_until && new Date(form.ai_paused_until).getTime() > mountedAt);
  const activeOrders = useMemo(() => detail?.orders.filter((order) => ["pending", "booked"].includes(order.order_status)).length ?? 0, [detail]);

  async function save() {
    if (!form) return;
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const response = await fetch(`/api/customers/${encodeURIComponent(phoneKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save AI memory");
      setDetail((current) => current ? { ...current, customer: { ...current.customer, ...data.customer } } : current);
      setNotice("✓ AI memory saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save AI memory");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">{[100, 130, 420].map((height) => <div key={height} className="animate-pulse rounded-2xl border-2 border-cardline bg-surface-soft" style={{ height }} />)}</main>;
  }

  if (!detail || !form) {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <Card className="py-14 text-center">
          <Froggy mood="sleepy" size={80} bob={false} className="mx-auto" />
          <h1 className="font-display text-xl font-extrabold">Customer unavailable</h1>
          <p className="mt-2 text-sm font-bold text-danger-ink">{error}</p>
          <Link href="/customers" className="mt-5 inline-block font-display font-extrabold text-frog-dark underline">Back to customers</Link>
        </Card>
      </main>
    );
  }

  const { customer, orders, messages, agent_runs: runs } = detail;
  const chatMode = !form.ai_enabled || isPaused ? "off" : "auto";

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Link href="/customers" className="rounded-xl border-2 border-cardline bg-surface px-3 py-2 font-display text-sm font-extrabold text-ink-soft hover:border-frog" aria-label="Back to customers">←</Link>
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-pond font-display text-2xl font-extrabold text-frog-dark">
          {customer.display_name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate font-display text-2xl font-extrabold text-ink sm:text-3xl">{customer.display_name}</h1>
            <StageBadge stage={customer.chat_state} />
          </div>
          <p className="text-sm font-bold text-ink-soft">{customer.primary_phone} · {languageName[customer.preferred_language]}</p>
        </div>
        <AiStateBadge mode={chatMode} />
        {customer.chat_id && <Link href={`/?chat=${encodeURIComponent(customer.chat_id)}`} className="btn3d border-grape-dark bg-grape text-white">💬 Open chat</Link>}
      </header>

      {error && <Card className="!border-danger-line bg-danger-bg p-4 font-display text-sm font-bold text-danger-ink">⚠️ {error}</Card>}
      {notice && <Card className="!border-frog bg-pond p-4 font-display text-sm font-extrabold text-frog-dark">{notice}</Card>}

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-4" aria-label="Customer performance">
        {[
          [money(customer.lifetime_revenue), "Delivered revenue", "text-frog-dark"],
          [customer.delivered_orders, "Delivered orders", "text-sky-dark"],
          [customer.returned_orders, "Returns", "text-flame-dark"],
          [activeOrders, "Active orders", "text-grape-dark"],
        ].map(([value, label, style]) => (
          <Card key={label} className="p-3 sm:p-4">
            <div className={`font-display text-xl font-extrabold sm:text-2xl ${style}`}>{value}</div>
            <div className="font-display text-[10px] font-bold uppercase text-ink-soft sm:text-xs">{label}</div>
          </Card>
        ))}
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(300px,0.85fr)_minmax(0,1.5fr)]">
        <aside className="space-y-5">
          <Card className="overflow-hidden">
            <div className="border-b-2 border-cardline bg-grape-tint p-4">
              <h2 className="font-display text-lg font-extrabold text-grape-dark">🧠 AI memory</h2>
              <p className="text-xs font-bold text-ink-soft">What the salesperson remembers for every reply.</p>
            </div>
            <div className="space-y-4 p-4">
              <label className="block font-display text-xs font-extrabold text-ink-soft">
                Customer name
                <input className={`${fieldClass} mt-1`} value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} />
              </label>
              <label className="block font-display text-xs font-extrabold text-ink-soft">
                Reply language
                <select className={`${fieldClass} mt-1`} value={form.preferred_language} onChange={(event) => setForm({ ...form, preferred_language: event.target.value as CustomerLanguage })}>
                  {Object.entries(languageName).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="block font-display text-xs font-extrabold text-ink-soft">
                Tags <span className="font-body font-semibold">(comma separated)</span>
                <input className={`${fieldClass} mt-1`} value={form.tags} placeholder="VIP, repeat buyer" onChange={(event) => setForm({ ...form, tags: event.target.value })} />
              </label>
              <label className="block font-display text-xs font-extrabold text-ink-soft">
                Private notes for AI
                <textarea className={`${fieldClass} mt-1 min-h-28 resize-y`} value={form.notes} placeholder="Preferences, context, delivery instructions..." onChange={(event) => setForm({ ...form, notes: event.target.value })} />
              </label>

              <div className="rounded-2xl border-2 border-cardline bg-surface-soft p-3">
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <span>
                    <span className="block font-display text-sm font-extrabold text-ink">Autonomous replies</span>
                    <span className="block text-xs font-bold text-ink-soft">Allow AI to talk to this customer</span>
                  </span>
                  <input type="checkbox" checked={form.ai_enabled} onChange={(event) => setForm({ ...form, ai_enabled: event.target.checked })} className="h-6 w-6 accent-[var(--color-frog)]" />
                </label>
                {form.ai_enabled && (
                  <button
                    type="button"
                    className="mt-3 w-full rounded-xl border-2 border-cardline bg-surface px-3 py-2 font-display text-xs font-extrabold text-ink-soft hover:border-flame"
                    onClick={() => setForm({ ...form, ai_paused_until: isPaused ? null : oneDayFromNow() })}
                  >
                    {isPaused ? "▶ Resume AI now" : "⏸ Pause AI for 24 hours"}
                  </button>
                )}
              </div>
              <Button className="w-full" onClick={() => void save()} disabled={saving}>{saving ? "Saving..." : "Save AI memory"}</Button>
            </div>
          </Card>
        </aside>

        <div className="space-y-5">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b-2 border-cardline p-4">
              <div>
                <h2 className="font-display text-lg font-extrabold text-ink">💬 Recent conversation</h2>
                <p className="text-xs font-bold text-ink-soft">Latest WhatsApp context</p>
              </div>
              <span className="text-xs font-bold text-ink-soft">{messages.length} messages</span>
            </div>
            <div className="max-h-[430px] space-y-3 overflow-y-auto bg-cream/40 p-4">
              {messages.length === 0 ? (
                <p className="py-10 text-center text-sm font-bold text-ink-soft">No conversation history available.</p>
              ) : messages.map((message) => (
                <div key={message.id} className={`flex ${message.fromMe ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] rounded-2xl border-2 px-3 py-2 ${message.fromMe ? "border-frog bg-pond" : "border-cardline bg-surface"}`}>
                    <p className="whitespace-pre-wrap text-sm font-semibold text-ink">{message.body || `[${message.media || "media"}]`}</p>
                    <p className="mt-1 text-right text-[10px] font-bold text-ink-soft">{timeAgo(message.timestamp * 1000)}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b-2 border-cardline p-4">
              <h2 className="font-display text-lg font-extrabold text-ink">✨ AI activity</h2>
              <p className="text-xs font-bold text-ink-soft">Every decision is visible and reviewable.</p>
            </div>
            <div className="divide-y-2 divide-cardline">
              {runs.length === 0 ? <p className="p-8 text-center text-sm font-bold text-ink-soft">The AI has not handled this customer yet.</p> : runs.slice(0, 12).map((run) => (
                <article key={run.id} className="p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <RunStatusBadge status={run.status} />
                    <span className="font-display text-sm font-extrabold text-ink">{run.intent?.replaceAll("_", " ") || "Unknown intent"}</span>
                    <span className="ml-auto text-xs font-bold text-ink-soft">{Math.round(run.confidence * 100)}% · {timeAgo(run.created_at)}</span>
                  </div>
                  {run.reply && <p className="mt-2 rounded-xl bg-grape-tint p-3 text-sm font-semibold text-ink">“{run.reply}”</p>}
                  {(run.decision?.handoff_reason || run.error) && <p className="mt-2 text-xs font-bold text-danger-ink">↗ {run.decision?.handoff_reason || run.error}</p>}
                </article>
              ))}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b-2 border-cardline p-4"><h2 className="font-display text-lg font-extrabold text-ink">📦 Order history</h2></div>
            <div className="divide-y-2 divide-cardline">
              {orders.length === 0 ? <p className="p-8 text-center text-sm font-bold text-ink-soft">No orders yet.</p> : orders.map((order) => (
                <div key={order.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-display text-sm font-extrabold text-ink">{order.order_no || "Order"} · {order.item_name}</p>
                    <p className="text-xs font-bold text-ink-soft">{timeAgo(order.created_at)} · {order.city || order.district || "Location not set"}</p>
                  </div>
                  <span className={`rounded-lg px-2 py-1 font-display text-[10px] font-extrabold uppercase ${order.order_status === "delivered" ? "bg-pond text-frog-dark" : order.order_status === "returned" ? "bg-flame-tint text-flame-dark" : "bg-sky-tint text-sky-dark"}`}>{order.order_status}</span>
                  <strong className="font-display text-sm text-ink">{money(order.total_cod)}</strong>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </main>
  );
}
