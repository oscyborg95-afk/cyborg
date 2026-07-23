"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CustomerSummary } from "@/lib/types";
import { Froggy } from "../components/froggy";
import { Card } from "../components/ui";
import { AiStateBadge, StageBadge, languageName, money, timeAgo } from "../components/crm-ui";

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [query, setQuery] = useState("");
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
    const needle = query.trim().toLowerCase();
    if (!needle) return customers;
    return customers.filter((customer) =>
      [customer.display_name, customer.primary_phone, customer.latest_message, ...customer.tags]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [customers, query]);

  const repeatBuyers = customers.filter((customer) => customer.delivered_orders > 1).length;
  const aiEnabled = customers.filter((customer) => customer.ai_enabled).length;

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <Froggy mood="happy" size={60} />
        <div>
          <h1 className="font-display text-2xl font-extrabold text-ink sm:text-3xl">Customers</h1>
          <p className="text-sm font-bold text-ink-soft">Every conversation, order and AI memory in one place.</p>
        </div>
      </header>

      <label className="relative block">
        <span className="sr-only">Search customers</span>
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lg">🔎</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name, phone, message or tag..."
          className="w-full rounded-2xl border-2 border-cardline bg-surface py-3.5 pl-12 pr-4 font-display text-sm font-bold text-ink outline-none transition focus:border-frog focus:ring-2 focus:ring-frog/20"
        />
      </label>

      <section className="grid grid-cols-3 overflow-hidden rounded-2xl border-2 border-cardline border-b-[5px] bg-surface" aria-label="Customer summary">
        {[
          [customers.length, "Total customers", "text-ink"],
          [repeatBuyers, "Repeat buyers", "text-frog-dark"],
          [aiEnabled, "AI enabled", "text-grape-dark"],
        ].map(([value, label, style], index) => (
          <div key={label} className={`p-3 text-center sm:p-5 ${index ? "border-l-2 border-cardline" : ""}`}>
            <div className={`font-display text-xl font-extrabold sm:text-3xl ${style}`}>{value}</div>
            <div className="font-display text-[10px] font-bold uppercase tracking-wide text-ink-soft sm:text-xs">{label}</div>
          </div>
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
                  <div className="flex items-center justify-between gap-5 sm:justify-end">
                    <div className="text-left sm:text-right">
                      <p className="font-display text-base font-extrabold text-frog-dark">{money(customer.lifetime_revenue)}</p>
                      <p className="text-[11px] font-bold text-ink-soft">{customer.delivered_orders} delivered · {customer.returned_orders} returned</p>
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
