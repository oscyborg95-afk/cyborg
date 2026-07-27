"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CustomerSummary } from "@/lib/types";
import { Froggy } from "../components/froggy";
import { Card } from "../components/ui";
import { AiStateBadge, StageBadge, languageName, money, timeAgo } from "../components/crm-ui";

type CustomerFilter = "all" | "leads" | "buyers" | "repeat" | "ai_on" | "ai_off";

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [query, setQuery] = useState("");
  const [stageFilter, setStageFilter] = useState<CustomerFilter>("all");
  const [showGuide, setShowGuide] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mountedAt] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/customers", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load customers");
      setCustomers(data.customers);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load customers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    return customers.filter((customer) => {
      // Stage filter
      if (stageFilter === "leads" && customer.total_orders > 0) return false;
      if (stageFilter === "buyers" && customer.total_orders === 0) return false;
      if (stageFilter === "repeat" && customer.total_orders <= 1) return false;
      if (stageFilter === "ai_on" && !customer.ai_enabled) return false;
      if (stageFilter === "ai_off" && customer.ai_enabled) return false;

      // Text query
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return [customer.display_name, customer.primary_phone, customer.latest_message, ...customer.tags]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [customers, query, stageFilter]);

  const repeatBuyers = customers.filter((customer) => customer.total_orders > 1).length;
  const buyersCount = customers.filter((customer) => customer.total_orders > 0).length;
  const leadsCount = customers.filter((customer) => customer.total_orders === 0).length;
  const activeOrdersCount = customers.filter((customer) => customer.active_orders > 0).length;
  const aiEnabled = customers.filter((customer) => customer.ai_enabled).length;
  const aiDisabled = customers.length - aiEnabled;

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Froggy mood="happy" size={60} />
          <div>
            <h1 className="font-display text-2xl font-extrabold text-ink sm:text-3xl">Customers CRM</h1>
            <p className="text-sm font-bold text-ink-soft">Every conversation, order history, language preference &amp; AI memory.</p>
          </div>
        </div>
        <button
          onClick={() => setShowGuide((prev) => !prev)}
          className="rounded-xl border-2 border-cardline bg-surface px-3 py-2 font-display text-xs font-extrabold text-ink hover:border-frog transition"
        >
          {showGuide ? "💡 Hide Guide" : "❓ How CRM Works"}
        </button>
      </header>

      {/* How CRM Works Guide Banner */}
      {showGuide && (
        <Card className="animate-pop p-4 sm:p-5 !border-frog bg-pond/30 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 font-display text-base font-extrabold text-frog-dark">
              <span>💡</span>
              <span>How does the Customer CRM work?</span>
            </div>
            <button
              onClick={() => setShowGuide(false)}
              className="text-xs font-bold text-frog-dark/70 hover:text-frog-dark"
            >
              ✕ Dismiss
            </button>
          </div>
          <p className="text-xs font-semibold text-ink-soft leading-relaxed">
            The CRM automatically organizes every WhatsApp phone number that interacts with your store into a single unified profile. You never have to manually create customer accounts!
          </p>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4 pt-1">
            <div className="rounded-xl border border-cardline/60 bg-surface p-3 text-xs">
              <div className="font-display font-extrabold text-ink mb-0.5">👤 1. Auto Profiles</div>
              <p className="text-ink-soft font-medium">Created instantly from incoming WhatsApp messages, saving phone numbers, names, and districts.</p>
            </div>
            <div className="rounded-xl border border-cardline/60 bg-surface p-3 text-xs">
              <div className="font-display font-extrabold text-ink mb-0.5">📊 2. Lifecycle Stages</div>
              <p className="text-ink-soft font-medium">Tracks progress from New Inquiry → Pending Order → Active Buyer → Repeat VIP.</p>
            </div>
            <div className="rounded-xl border border-cardline/60 bg-surface p-3 text-xs">
              <div className="font-display font-extrabold text-ink mb-0.5">🤖 3. Per-Customer AI</div>
              <p className="text-ink-soft font-medium">Enable or pause AI auto-replies for individual customers with a single click inside their profile.</p>
            </div>
            <div className="rounded-xl border border-cardline/60 bg-surface p-3 text-xs">
              <div className="font-display font-extrabold text-ink mb-0.5">📜 4. Complete Audit Trail</div>
              <p className="text-ink-soft font-medium">Click any customer to inspect complete WhatsApp chat history, past order COD records &amp; AI notes.</p>
            </div>
          </div>
        </Card>
      )}

      {/* Search & Filters Toolbar */}
      <div className="space-y-3">
        <label className="relative block">
          <span className="sr-only">Search customers</span>
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lg">🔎</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, phone number, message content or tag..."
            className="w-full rounded-2xl border-2 border-cardline bg-surface py-3 pl-12 pr-4 font-display text-sm font-bold text-ink outline-none transition focus:border-frog focus:ring-2 focus:ring-frog/20"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft shrink-0">
            🏷️ Filter:
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                ["all", `All (${customers.length})`],
                ["leads", `Leads (${leadsCount})`],
                ["buyers", `Buyers (${buyersCount})`],
                ["repeat", `Repeat VIPs (${repeatBuyers})`],
                ["ai_on", `AI Live (${aiEnabled})`],
                ["ai_off", `AI Off (${aiDisabled})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setStageFilter(key)}
                className={`rounded-xl border-2 px-3 py-1.5 font-display text-xs font-extrabold transition ${
                  stageFilter === key
                    ? "border-frog bg-pond text-frog-dark shadow-xs"
                    : "border-cardline bg-surface text-ink-soft hover:border-frog/50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3" aria-label="Customer summary">
        {[
          [customers.length, "Total customers", "text-ink"],
          [buyersCount, "Customers w/ orders", "text-frog-dark"],
          [activeOrdersCount, "Active in-flight orders", "text-gold-dark"],
          [repeatBuyers, "Repeat buyers (2+)", "text-grape-dark"],
        ].map(([value, label, style]) => (
          <Card key={label} className="p-3 text-center sm:p-4">
            <div className={`font-display text-xl font-extrabold sm:text-2xl ${style}`}>{value}</div>
            <div className="font-display text-[10px] font-bold uppercase tracking-wide text-ink-soft sm:text-xs">{label}</div>
          </Card>
        ))}
      </section>

      {error && (
        <Card className="!border-danger-line bg-danger-bg p-5 text-center">
          <p className="font-display text-sm font-bold text-danger-ink">⚠️ {error}</p>
          <button onClick={() => void load()} className="mt-2 font-display text-sm font-extrabold text-danger-ink underline">Try again</button>
        </Card>
      )}

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((item) => <div key={item} className="h-28 animate-pulse rounded-2xl border-2 border-cardline bg-surface-soft" />)}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="py-14 text-center">
          <div className="text-4xl">🔎</div>
          <h2 className="mt-3 font-display text-xl font-extrabold">{query ? "No matching customers" : "No customers yet"}</h2>
          <p className="mt-1 text-sm font-bold text-ink-soft">{query ? "Try a name, phone number or tag." : "Profiles appear when customers message or place orders."}</p>
        </Card>
      ) : (
        <section className="space-y-3" aria-label={`${filtered.length} customers`}>
          {filtered.map((customer) => {
            const paused = customer.ai_paused_until && new Date(customer.ai_paused_until).getTime() > mountedAt;
            return (
              <Link key={customer.phone_key} href={`/customers/${encodeURIComponent(customer.phone_key)}`} className="group block">
                <Card className="grid gap-4 p-4 transition group-hover:-translate-y-0.5 group-hover:!border-frog sm:grid-cols-[minmax(180px,1.2fr)_minmax(180px,1.5fr)_auto] sm:items-center">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-pond font-display text-lg font-extrabold text-frog-dark">
                        {(customer.display_name || "?").slice(0, 1).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <h2 className="truncate font-display text-base font-extrabold text-ink">{customer.display_name}</h2>
                        <p className="truncate text-xs font-bold text-ink-soft">{customer.primary_phone} · {languageName[customer.preferred_language]}</p>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <StageBadge stage={customer.chat_state} />
                      {customer.tags.slice(0, 3).map((tag) => <span key={tag} className="rounded-lg bg-surface-soft px-2 py-1 text-[10px] font-extrabold text-ink-soft">#{tag}</span>)}
                    </div>
                  </div>
                  <div className="min-w-0 border-y-2 border-cardline py-3 sm:border-x-2 sm:border-y-0 sm:px-4 sm:py-1">
                    <p className="truncate text-sm font-bold text-ink">{customer.latest_message || "No recent message"}</p>
                    <p className="mt-1 text-xs font-bold text-ink-soft">{timeAgo(customer.latest_message_at)} · {customer.unread_count ? `${customer.unread_count} unread` : "all read"}</p>
                  </div>
                  <div className="flex items-center justify-between gap-4 sm:justify-end">
                    <div className="flex flex-col items-end gap-1 min-w-[130px]">
                      {customer.active_orders > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-gold/25 px-2.5 py-0.5 font-display text-xs font-extrabold text-gold-dark border border-gold/40">
                          📦 {customer.active_orders} active order{customer.active_orders > 1 ? "s" : ""}
                        </span>
                      ) : customer.delivered_orders > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-pond px-2.5 py-0.5 font-display text-xs font-extrabold text-frog-dark border border-frog/30">
                          ✅ {customer.delivered_orders} delivered
                        </span>
                      ) : customer.returned_orders > 0 ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-flame-tint px-2.5 py-0.5 font-display text-xs font-extrabold text-flame-dark border border-flame/30">
                          ↩️ {customer.returned_orders} returned
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-surface-soft px-2.5 py-0.5 font-display text-xs font-bold text-ink-soft border border-cardline">
                          💬 Inquiry lead
                        </span>
                      )}

                      <div className="text-right text-[11px] font-bold text-ink-soft">
                        {customer.total_orders > 0 ? (
                          <span>
                            {customer.total_orders} order{customer.total_orders > 1 ? "s" : ""}
                            {customer.lifetime_revenue > 0 ? ` · ${money(customer.lifetime_revenue)}` : customer.active_cod_total > 0 ? ` · ${money(customer.active_cod_total)} COD` : ""}
                          </span>
                        ) : (
                          <span>No orders placed</span>
                        )}
                      </div>
                    </div>
                    <AiStateBadge mode={!customer.ai_enabled || paused ? "off" : "auto"} compact />
                    <span className="font-display text-xl font-extrabold text-ink-soft transition group-hover:translate-x-1 group-hover:text-frog-dark">›</span>
                  </div>
                </Card>
              </Link>
            );
          })}
        </section>
      )}
    </main>
  );
}
