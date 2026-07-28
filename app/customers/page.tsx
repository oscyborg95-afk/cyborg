"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CustomerSummary } from "@/lib/types";
import { Froggy } from "../components/froggy";
import { Card } from "../components/ui";
import { languageName, money, timeAgo } from "../components/crm-ui";

type Segment = "all" | "leads" | "buyers" | "repeat" | "at_risk";

const FILTERS: Array<{ key: Segment; label: string }> = [
  { key: "all", label: "All" },
  { key: "leads", label: "Leads" },
  { key: "buyers", label: "Buyers" },
  { key: "repeat", label: "Repeat buyers" },
  { key: "at_risk", label: "At-risk / returns" },
];

function segmentName(customer: CustomerSummary) {
  if (customer.returned_orders > 0) return "At-risk";
  if (customer.total_orders > 1) return "Repeat buyer";
  if (customer.total_orders > 0) return "Buyer";
  return "Lead";
}

function matchesSegment(customer: CustomerSummary, segment: Segment) {
  if (segment === "leads") return customer.total_orders === 0;
  if (segment === "buyers") return customer.total_orders > 0;
  if (segment === "repeat") return customer.total_orders > 1;
  if (segment === "at_risk") return customer.returned_orders > 0;
  return true;
}

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerSummary[]>([]);
  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState<Segment>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
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
    return customers.filter((customer) => {
      if (!matchesSegment(customer, segment)) return false;
      if (!needle) return true;
      return [customer.display_name, customer.primary_phone, customer.latest_message, ...customer.tags]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [customers, query, segment]);

  const counts = useMemo(
    () => ({
      buyers: customers.filter((customer) => customer.total_orders > 0).length,
      repeat: customers.filter((customer) => customer.total_orders > 1).length,
      revenue: customers.reduce((sum, customer) => sum + customer.lifetime_revenue, 0),
    }),
    [customers]
  );

  function exportCsv() {
    const rows = [
      ["Name", "Phone", "Customer type", "Total orders", "Delivered orders", "Returned orders", "Delivered revenue", "Last order", "Tags"],
      ...filtered.map((customer) => [
        customer.display_name,
        customer.primary_phone,
        segmentName(customer),
        customer.total_orders,
        customer.delivered_orders,
        customer.returned_orders,
        customer.lifetime_revenue,
        customer.last_order_at ?? "",
        customer.tags.join("; "),
      ]),
    ];
    const blob = new Blob([`\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\n")}`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `customers-${segment}-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex min-w-0 items-start gap-3 sm:contents">
          <Froggy mood="happy" size={52} />
          <div className="min-w-0 flex-1">
            <h1 className="font-display text-2xl font-extrabold leading-tight text-ink sm:text-3xl">Customers you can campaign to</h1>
            <p className="mt-1 text-sm font-bold text-ink-soft">Complete purchase history and useful customer segments in one place.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={exportCsv}
          disabled={loading || filtered.length === 0}
          className="w-full rounded-xl border-2 border-grape bg-grape-tint px-4 py-2 font-display text-xs font-extrabold text-grape-dark transition hover:bg-grape hover:text-white focus:outline-none focus:ring-2 focus:ring-grape disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          ↓ Export {filtered.length} to CSV
        </button>
      </header>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3" aria-label="Customer summary">
        {[
          [error ? "—" : customers.length, "Customer profiles", "text-ink"],
          [error ? "—" : counts.buyers, "Purchased", "text-frog-dark"],
          [error ? "—" : counts.repeat, "Repeat buyers", "text-grape-dark"],
          [error ? "—" : money(counts.revenue), "Delivered revenue", "text-frog-dark"],
        ].map(([value, label, color]) => (
          <Card key={label} className="p-3 sm:p-4">
            <div className={`font-display text-xl font-extrabold sm:text-2xl ${color}`}>{value}</div>
            <div className="mt-1 font-display text-[10px] font-bold uppercase tracking-wide text-ink-soft sm:text-xs">{label}</div>
          </Card>
        ))}
      </section>

      <section className="space-y-3" aria-label="Find customer segments">
        <label className="relative block">
          <span className="sr-only">Search customers</span>
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2">🔎</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, phone, message or tag"
            className="w-full rounded-2xl border-2 border-cardline bg-surface py-3 pl-11 pr-4 font-display text-sm font-bold text-ink outline-none transition focus:border-grape focus:ring-2 focus:ring-grape/20"
          />
        </label>
        <div className="flex flex-wrap gap-2" aria-label="Customer segment filters">
          {FILTERS.map((filter) => {
            const count = customers.filter((customer) => matchesSegment(customer, filter.key)).length;
            return (
              <button
                type="button"
                key={filter.key}
                onClick={() => setSegment(filter.key)}
                className={`shrink-0 rounded-xl border-2 px-3 py-2 font-display text-xs font-extrabold transition focus:outline-none focus:ring-2 focus:ring-grape ${
                  segment === filter.key
                    ? "border-grape bg-grape-tint text-grape-dark"
                    : "border-cardline bg-surface text-ink-soft hover:border-grape"
                }`}
              >
                {filter.label} · {count}
              </button>
            );
          })}
        </div>
      </section>

      {error && (
        <Card className="flex flex-wrap items-center justify-between gap-3 !border-danger-line bg-danger-bg p-4">
          <p className="font-display text-sm font-bold text-danger-ink">⚠️ {error}</p>
          <button type="button" onClick={() => void load()} className="font-display text-sm font-extrabold text-danger-ink underline">Try again</button>
        </Card>
      )}

      {error ? null : loading ? (
        <div className="space-y-3" aria-label="Loading customers">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex h-20 animate-pulse items-center gap-3 rounded-2xl border-2 border-cardline bg-surface p-4">
              <span className="h-10 w-10 shrink-0 rounded-xl bg-surface-soft" />
              <span className="flex-1 space-y-2">
                <span className="block h-3 w-40 max-w-full rounded bg-surface-soft" />
                <span className="block h-2 w-28 max-w-full rounded bg-surface-soft" />
              </span>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="py-12 text-center">
          <h2 className="font-display text-xl font-extrabold text-ink">{query ? "No matching customers" : "This segment is empty"}</h2>
          <p className="mt-1 text-sm font-bold text-ink-soft">Try another segment or search term.</p>
        </Card>
      ) : (
        <section className="space-y-3" aria-label={`${filtered.length} customers`}>
          {filtered.map((customer) => {
            const customerSegment = segmentName(customer);
            const segmentColor =
              customerSegment === "At-risk"
                ? "bg-gold/20 text-gold-dark"
                : customerSegment === "Lead"
                  ? "bg-sky-tint text-sky-dark"
                  : "bg-grape-tint text-grape-dark";
            return (
              <Card key={customer.phone_key} className="p-4 transition hover:!border-grape sm:p-5">
                <div className="grid gap-4 sm:grid-cols-[minmax(180px,1fr)_minmax(240px,1.4fr)_auto] sm:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-pond font-display text-lg font-extrabold text-frog-dark">
                      {(customer.display_name || "?").slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <h2 className="truncate font-display text-base font-extrabold text-ink">{customer.display_name}</h2>
                      <p className="truncate text-xs font-bold text-ink-soft">{customer.primary_phone} · {languageName[customer.preferred_language]}</p>
                      <span className={`mt-1 inline-block rounded-lg px-2 py-1 font-display text-[10px] font-extrabold uppercase ${segmentColor}`}>{customerSegment}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center sm:text-left">
                    <div>
                      <p className="font-display text-sm font-extrabold text-frog-dark">{money(customer.lifetime_revenue)}</p>
                      <p className="text-[10px] font-bold uppercase text-ink-soft">Delivered</p>
                    </div>
                    <div>
                      <p className="font-display text-sm font-extrabold text-ink">{customer.total_orders} orders</p>
                      <p className="text-[10px] font-bold uppercase text-ink-soft">{customer.returned_orders} returned</p>
                    </div>
                    <div>
                      <p className="font-display text-sm font-extrabold text-ink">{customer.last_order_at ? timeAgo(customer.last_order_at) : "Never"}</p>
                      <p className="text-[10px] font-bold uppercase text-ink-soft">Last purchase</p>
                    </div>
                    {customer.tags.length > 0 && (
                      <div className="col-span-3 flex flex-wrap gap-1 pt-1">
                        {customer.tags.slice(0, 4).map((tag) => <span key={tag} className="rounded-md bg-surface-soft px-2 py-1 text-[10px] font-extrabold text-ink-soft">#{tag}</span>)}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 sm:flex-col">
                    <Link href={`/customers/${encodeURIComponent(customer.phone_key)}`} className="flex-1 rounded-xl border-2 border-grape bg-grape px-3 py-2 text-center font-display text-xs font-extrabold text-white focus:outline-none focus:ring-2 focus:ring-grape">View profile</Link>
                    {customer.chat_id && <Link href={`/?chat=${encodeURIComponent(customer.chat_id)}`} className="flex-1 rounded-xl border-2 border-cardline bg-surface px-3 py-2 text-center font-display text-xs font-extrabold text-ink hover:border-grape focus:outline-none focus:ring-2 focus:ring-grape">Open chat</Link>}
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
