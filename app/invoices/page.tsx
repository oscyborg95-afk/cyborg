"use client";

// Batch invoice printing: pick a day or range, get every booked order as 8-up A4 sheets
// (2 × 4 per page), each with the business block, customer block, item, COD
// breakdown and a scannable Code-128 barcode of the courier tracking ID.
// Browser print → save the whole batch as one PDF or send straight to paper.
//
// Data comes from /api/invoices, which reads only the chosen day/range (plus the
// few neighbouring orders needed to spot duplicates), so changing the date is a
// small query instead of the whole Orders feed.

import { useEffect, useMemo, useRef, useState } from "react";
import type { BusinessSettings, Order, ShippingManifest } from "@/lib/types";
import { findDuplicates, type DuplicateCandidate, type DuplicateMatch } from "@/lib/risk";
import { Barcode } from "../components/barcode";
import { CancelOrderDialog } from "../components/cancel-order-dialog";
import { Froggy } from "../components/froggy";
import { Button, Card } from "../components/ui";

const rs = (n: number) => `Rs. ${Math.round(n).toLocaleString("en-LK")}`;

// Local midnight of a YYYY-MM-DD day as an ISO instant, so the server cuts the
// batch on the operator's calendar day, not UTC's.
const localMidnight = (day: string, addDays = 0) => {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + addDays);
  return d.toISOString();
};

type RelatedOrder = DuplicateCandidate & Pick<Order, "order_no" | "customer_name" | "total_cod">;

function describeMatch(m: DuplicateMatch<RelatedOrder>, inBatch: boolean): string {
  const ref = m.order.order_no || m.order.customer_name;
  const when = m.hoursApart < 1 ? "<1h apart" : `${Math.round(m.hoursApart)}h apart`;
  const where = inBatch ? "also in this batch" : m.order.order_status === "pending" ? "still pending" : `already ${m.order.order_status}`;
  return `${ref} · ${m.sameItem ? "same item" : "different item"} · ${when} · ${where}`;
}

// "unprinted": every booked order whose invoice hasn't been printed yet,
// whatever day it was dispatched — the default, so leftovers from yesterday's
// half-printed batch are simply waiting here.
// "history": invoices already printed, grouped by when they were printed, so a
// lost or spoiled batch can be reprinted.
type DateFilterMode = "unprinted" | "single" | "range" | "all" | "history";

const printedLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function InvoicesPage() {
  const today = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const [orders, setOrders] = useState<Order[]>([]);
  const [manifests, setManifests] = useState<ShippingManifest[]>([]);
  const [related, setRelated] = useState<RelatedOrder[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [onlyDuplicates, setOnlyDuplicates] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<Order | null>(null);
  // After the print dialog closes: which orders just went to the printer,
  // waiting for the operator to confirm they actually came out.
  const [printCheck, setPrintCheck] = useState<string[] | null>(null);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [filterMode, setFilterMode] = useState<DateFilterMode>("unprinted");
  const [date, setDate] = useState(today);
  const [rangeFrom, setRangeFrom] = useState(today);
  const [rangeTo, setRangeTo] = useState(today);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);

  const rangeIsValid = Boolean(rangeFrom && rangeTo && rangeFrom <= rangeTo);

  // Business details print on every invoice — read once, not per date change.
  useEffect(() => {
    let live = true;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => live && data && setSettings(data.settings))
      .catch(() => null);
    return () => {
      live = false;
    };
  }, []);

  // The batch window the server should read; null = the latest dispatches.
  const batchQuery = useMemo(() => {
    if (filterMode === "unprinted") return "unprinted=1";
    if (filterMode === "history") return "printed=1";
    if (filterMode === "all") return "";
    if (filterMode === "single") {
      if (!date) return null;
      return `from=${encodeURIComponent(localMidnight(date))}&to=${encodeURIComponent(localMidnight(date, 1))}`;
    }
    if (!rangeIsValid) return null;
    return `from=${encodeURIComponent(localMidnight(rangeFrom))}&to=${encodeURIComponent(localMidnight(rangeTo, 1))}`;
  }, [filterMode, date, rangeFrom, rangeTo, rangeIsValid]);

  useEffect(() => {
    if (batchQuery === null) return;
    const ctrl = new AbortController();
    // Debounced so scrubbing through dates in the picker is one read, not ten.
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/invoices${batchQuery ? `?${batchQuery}` : ""}`, { signal: ctrl.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Invoices could not be loaded");
        setOrders(data.orders);
        setManifests(data.manifests);
        setRelated(data.related);
        // Already-printed invoices start unticked, so a date batch defaults to
        // only what still needs printing; tick one to reprint it. In print
        // history that is everything — pick a batch to reprint.
        setExcluded(
          new Set((data.orders as Order[]).filter((o) => o.invoice_printed_at).map((o) => o.id))
        );
        setLoadError(null);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : "Invoices could not be loaded");
      } finally {
        if (!ctrl.signal.aborted) setLoaded(true);
      }
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [batchQuery]);

  useEffect(() => {
    if (!previewOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    previewCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPreviewOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = previewRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [previewOpen]);

  const manifestByOrder = useMemo(() => {
    const map = new Map<string, ShippingManifest>();
    for (const m of manifests) map.set(m.order_id, m);
    return map;
  }, [manifests]);

  // Printable = has a tracking ID (was actually handed to the courier) and was
  // not cancelled afterwards. The server already cut the batch to the dates.
  const eligible = useMemo(
    () =>
      batchQuery === null
        ? []
        : orders
            .filter((o) => manifestByOrder.has(o.id) && o.order_status !== "cancelled")
            .filter((o) => filterMode !== "unprinted" || !o.invoice_printed_at)
            .filter((o) => filterMode !== "history" || o.invoice_printed_at)
            .sort((a, b) =>
              filterMode === "history"
                ? (b.invoice_printed_at ?? "").localeCompare(a.invoice_printed_at ?? "") ||
                  a.created_at.localeCompare(b.created_at)
                : a.created_at.localeCompare(b.created_at)
            ),
    [orders, manifestByOrder, batchQuery, filterMode]
  );
  const printedInBatch = eligible.filter((o) => o.invoice_printed_at).length;
  const cancelledInBatch = batchQuery === null ? 0 : orders.filter((o) => o.order_status === "cancelled").length;

  // Possible duplicates: same customer phone, another live order within 72h —
  // checked against this batch and the neighbouring orders the server sent.
  const duplicates = useMemo(() => {
    const candidates: RelatedOrder[] = [...eligible, ...related];
    const map = new Map<string, DuplicateMatch<RelatedOrder>[]>();
    for (const o of eligible) {
      const matches = findDuplicates(candidates, o);
      if (matches.length) map.set(o.id, matches);
    }
    return map;
  }, [eligible, related]);
  const eligibleIds = useMemo(() => new Set(eligible.map((o) => o.id)), [eligible]);

  // Within each duplicate cluster in this batch, every order after the first.
  const laterDuplicates = useMemo(
    () =>
      eligible.filter((o) =>
        (duplicates.get(o.id) ?? []).some(
          (m) => eligibleIds.has(m.order.id) && m.order.created_at < o.created_at
        )
      ),
    [eligible, duplicates, eligibleIds]
  );

  const listed = onlyDuplicates ? eligible.filter((o) => duplicates.has(o.id)) : eligible;
  // Print history groups by print run: one confirmation stamps the whole batch
  // with the same instant, so equal stamps = one stack of paper.
  const listGroups = useMemo(() => {
    if (filterMode !== "history") return [{ key: "all", printedAt: null as string | null, orders: listed }];
    const groups: Array<{ key: string; printedAt: string | null; orders: Order[] }> = [];
    for (const o of listed) {
      const last = groups[groups.length - 1];
      if (last && last.key === o.invoice_printed_at) last.orders.push(o);
      else groups.push({ key: o.invoice_printed_at ?? "", printedAt: o.invoice_printed_at ?? null, orders: [o] });
    }
    return groups;
  }, [filterMode, listed]);
  const selected = useMemo(() => eligible.filter((o) => !excluded.has(o.id)), [eligible, excluded]);
  const sheets = useMemo(() => chunk(selected, 8), [selected]);

  const excludeLaterDuplicates = () =>
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const o of laterDuplicates) next.add(o.id);
      return next;
    });

  // Tick exactly this print run (and nothing else) for a reprint.
  const selectOnly = (ids: string[]) => {
    const keep = new Set(ids);
    setExcluded(new Set(eligible.filter((o) => !keep.has(o.id)).map((o) => o.id)));
  };

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Record (or undo) "printed" for these orders, then patch them locally — the
  // batch is not re-read. Printed ones drop out of "Not printed yet" and are
  // unticked in a date batch.
  const markPrinted = async (ids: string[], printed: boolean) => {
    if (ids.length === 0) return;
    setMarking(true);
    setMarkError(null);
    try {
      const res = await fetch("/api/invoices/printed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, printed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save the print status");
      const stamps = new Map<string, string | null>(
        (data.updated as Array<{ id: string; invoice_printed_at: string | null }>).map((u) => [u.id, u.invoice_printed_at])
      );
      setOrders((prev) =>
        prev.map((o) => (stamps.has(o.id) ? { ...o, invoice_printed_at: stamps.get(o.id) ?? null } : o))
      );
      setExcluded((prev) => {
        const next = new Set(prev);
        for (const id of stamps.keys()) {
          if (printed) next.add(id);
          else next.delete(id);
        }
        return next;
      });
      setPrintCheck(null);
    } catch (err) {
      setMarkError(err instanceof Error ? err.message : "Could not save the print status");
    } finally {
      setMarking(false);
    }
  };

  // Snapshot the batch when printing starts (button or Ctrl+P) and ask once the
  // dialog closes — the browser can't tell us whether paper actually came out.
  // A reprint from history is already recorded, and re-stamping would break its
  // print run apart — so history never asks.
  const selectedIdsRef = useRef<string[]>([]);
  useEffect(() => {
    selectedIdsRef.current = filterMode === "history" ? [] : selected.map((o) => o.id);
  }, [selected, filterMode]);
  useEffect(() => {
    let snapshot: string[] = [];
    const onBefore = () => {
      snapshot = selectedIdsRef.current;
    };
    const onAfter = () => {
      if (snapshot.length) setPrintCheck(snapshot);
    };
    window.addEventListener("beforeprint", onBefore);
    window.addEventListener("afterprint", onAfter);
    return () => {
      window.removeEventListener("beforeprint", onBefore);
      window.removeEventListener("afterprint", onAfter);
    };
  }, []);

  const missingProfile =
    settings && !settings.business_name && !settings.business_address ? true : false;

  // The browser's "Save as PDF" names the file after document.title, so build the
  // name the operator would otherwise type by hand: business, dates, batch size.
  const printFileName = useMemo(() => {
    const brand = settings?.business_name?.trim() || "Invoices";
    const span =
      filterMode === "unprinted"
        ? today
        : filterMode === "history"
        ? `reprint ${today}`
        : filterMode === "all"
        ? "all dates"
        : filterMode === "single"
          ? date
          : rangeFrom === rangeTo
            ? rangeFrom
            : `${rangeFrom} to ${rangeTo}`;
    const count = `${selected.length} invoice${selected.length === 1 ? "" : "s"}`;
    // Windows and macOS both reject these in filenames; the browser would
    // silently mangle them into something worse than a dash.
    return `${brand} ${span} (${count})`.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
  }, [settings, filterMode, today, date, rangeFrom, rangeTo, selected.length]);

  // Swapped in around the print itself — on beforeprint rather than only in the
  // button handler, so Ctrl+P gets the same filename — and put back afterwards.
  useEffect(() => {
    const appTitle = document.title;
    const stamp = () => {
      document.title = printFileName;
    };
    const restore = () => {
      document.title = appTitle;
    };
    window.addEventListener("beforeprint", stamp);
    window.addEventListener("afterprint", restore);
    return () => {
      window.removeEventListener("beforeprint", stamp);
      window.removeEventListener("afterprint", restore);
      restore();
    };
  }, [printFileName]);

  return (
    <div className="min-h-full">
      {/* ── Controls (hidden in print) ─────────────────────────────── */}
      <div className="print-hide mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <div className="flex items-center gap-3">
          <Froggy mood={selected.length > 0 ? "happy" : "idle"} size={56} />
          <div>
            <h1 className="font-display text-2xl font-extrabold text-ink">Invoice printer</h1>
            <p className="font-display text-sm font-bold text-ink-soft">
              8 invoices per A4 sheet · print or save the selected batch as one PDF
            </p>
          </div>
        </div>

        {missingProfile && (
          <Card className="!border-flame bg-flame-tint p-4">
            <p className="font-display text-sm font-bold text-ink">
              🏪 Your business name &amp; address are empty — they print on every invoice. Fill
              them in on the <a href="/analytics" className="text-flame-dark underline">Quest page settings</a>.
            </p>
          </Card>
        )}

        {!loaded && (
          <Card className="flex items-center gap-3 p-4" aria-busy="true">
            <Froggy mood="thinking" size={48} />
            <div>
              <p className="font-display text-base font-extrabold text-ink">Finding printable shipments…</p>
              <p className="text-sm font-semibold text-ink-soft">Checking orders and courier tracking IDs.</p>
            </div>
          </Card>
        )}

        <Card className="flex min-w-0 flex-col items-stretch gap-4 p-4 sm:flex-row sm:flex-wrap sm:items-end">
          <fieldset className="min-w-0 space-y-3">
            <legend className="font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">
              Which invoices
            </legend>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              {([
                ["unprinted", "Not printed yet"],
                ["single", "Single day"],
                ["range", "Date range"],
                ["all", "All days"],
                ["history", "🕘 Print history"],
              ] as const).map(([mode, label]) => (
                <label
                  key={mode}
                  className={`flex min-h-11 cursor-pointer items-center justify-center rounded-xl border-2 px-2 py-2 text-center font-display text-sm font-extrabold leading-tight transition-colors focus-within:ring-2 focus-within:ring-frog focus-within:ring-offset-2 sm:px-3 ${
                    filterMode === mode
                      ? "border-frog bg-pond text-ink"
                      : "border-cardline bg-cream/60 text-ink-soft hover:border-frog/60"
                  }`}
                >
                  <input
                    type="radio"
                    name="invoice-date-filter"
                    value={mode}
                    checked={filterMode === mode}
                    onChange={() => setFilterMode(mode)}
                    className="sr-only"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          {filterMode === "single" && (
            <label className="flex flex-col gap-1 font-display text-sm font-bold text-ink-soft sm:block">
              Day
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="min-h-11 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 font-display text-base font-bold text-ink outline-none focus:border-frog sm:ml-2 sm:w-auto sm:text-sm"
              />
            </label>
          )}

          {filterMode === "range" && (
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-start">
              <label className="flex flex-col gap-1 font-display text-sm font-bold text-ink-soft sm:block">
                From
                <input
                  type="date"
                  value={rangeFrom}
                  max={rangeTo || undefined}
                  aria-describedby={!rangeIsValid ? "invoice-range-error" : undefined}
                  aria-invalid={!rangeIsValid}
                  onChange={(e) => setRangeFrom(e.target.value)}
                  className="min-h-11 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 font-display text-base font-bold text-ink outline-none focus:border-frog sm:ml-2 sm:w-auto sm:text-sm"
                />
              </label>
              <label className="flex flex-col gap-1 font-display text-sm font-bold text-ink-soft sm:block">
                To
                <input
                  type="date"
                  value={rangeTo}
                  min={rangeFrom || undefined}
                  aria-describedby={!rangeIsValid ? "invoice-range-error" : undefined}
                  aria-invalid={!rangeIsValid}
                  onChange={(e) => setRangeTo(e.target.value)}
                  className="min-h-11 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 font-display text-base font-bold text-ink outline-none focus:border-frog sm:ml-2 sm:w-auto sm:text-sm"
                />
              </label>
              {!rangeIsValid && (
                <p id="invoice-range-error" role="alert" className="basis-full font-display text-xs font-extrabold text-flame-dark">
                  Choose a From date on or before the To date.
                </p>
              )}
            </div>
          )}

          <span className="rounded-xl bg-pond/70 px-3 py-2 font-display text-sm font-bold text-ink sm:bg-transparent sm:px-0 sm:py-0">
            {selected.length} of {eligible.length} shipments selected · {sheets.length}{" "}
            {sheets.length === 1 ? "sheet" : "sheets"}
            {(filterMode === "all" || filterMode === "history") && orders.length >= 300 && " · latest 300 only"}
            {printedInBatch > 0 && filterMode !== "history" && ` · ${printedInBatch} already printed`}
          </span>
          <div className="grid grid-cols-2 gap-2 sm:ml-auto sm:flex">
            <Button tone="sky" className="sm:hidden" disabled={selected.length === 0} onClick={() => setPreviewOpen(true)}>
              👀 Preview
            </Button>
            <Button tone="frog" disabled={selected.length === 0} onClick={() => window.print()}>
              🖨️ <span className="sm:hidden">Print</span><span className="hidden sm:inline">Print / Save PDF</span>
            </Button>
            {filterMode !== "history" && (
              <Button
                tone="ghost"
                className="col-span-2 !text-sm sm:col-span-1"
                disabled={selected.length === 0 || marking}
                onClick={() => void markPrinted(selected.map((o) => o.id), true)}
                title="Already printed these some other way? Record them without printing again."
              >
                ✓ Mark selected as printed
              </Button>
            )}
          </div>
          {selected.length > 0 && (
            <p className="mt-2 text-xs font-semibold text-ink-soft">
              Saves as <span className="font-mono text-ink">{printFileName}.pdf</span> — no renaming needed.
            </p>
          )}
        </Card>

        {loaded && eligible.length === 0 && (
          <Card className="flex flex-col items-center gap-3 p-10 text-center">
            <Froggy mood="sleepy" size={90} />
            <p className="font-display text-lg font-extrabold text-ink">
              {filterMode === "unprinted"
                ? "Everything is printed 🎉"
                : filterMode === "history"
                ? "Nothing printed yet"
                : filterMode === "all"
                ? "No shipped orders yet"
                : filterMode === "range"
                  ? rangeIsValid
                    ? "No shipped orders in this date range"
                    : "This date range is invalid"
                  : "No shipped orders on this day"}
            </p>
            <p className="font-display text-sm font-bold text-ink-soft">
              {filterMode === "unprinted"
                ? "New dispatches show up here until you confirm their invoices printed."
                : filterMode === "history"
                ? "Once you confirm a batch printed, it shows up here so you can reprint it."
                : "Invoices appear here once orders are dispatched with a tracking ID."}
            </p>
          </Card>
        )}

        {(loadError || markError) && (
          <Card className="!border-flame bg-flame-tint p-4">
            <p role="alert" className="font-display text-sm font-bold text-flame-dark">⚠️ {loadError || markError}</p>
          </Card>
        )}

        {duplicates.size > 0 && (
          <Card className="!border-flame bg-flame-tint p-4">
            <p className="font-display text-base font-extrabold text-flame-dark">
              ⚠️ {duplicates.size} possible duplicate{duplicates.size === 1 ? "" : "s"} in this batch
            </p>
            <p className="mt-1 text-sm font-semibold text-ink">
              Same customer phone with another live order within 72 hours. Check them before printing —
              cancel the extra one, or just leave it out of this batch.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button tone={onlyDuplicates ? "flame" : "ghost"} onClick={() => setOnlyDuplicates((v) => !v)} className="!px-3 !py-2 !text-sm">
                {onlyDuplicates ? "Show all shipments" : "🔍 Show only duplicates"}
              </Button>
              {laterDuplicates.length > 0 && (
                <Button tone="ghost" onClick={excludeLaterDuplicates} className="!px-3 !py-2 !text-sm">
                  Leave out {laterDuplicates.length} repeat{laterDuplicates.length === 1 ? "" : "s"} (keep the first)
                </Button>
              )}
            </div>
          </Card>
        )}

        {eligible.length > 0 && (
          <Card className="p-4">
            <p className="mb-2 font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">
              {filterMode === "history" ? "Pick invoices to reprint" : "Include / exclude"}
              {cancelledInBatch > 0 && (
                <span className="ml-2 normal-case tracking-normal">
                  · {cancelledInBatch} cancelled shipment{cancelledInBatch === 1 ? "" : "s"} hidden
                </span>
              )}
            </p>
            {listGroups.map((group) => (
            <div key={group.key} className="mt-3 first-of-type:mt-0">
            {group.printedAt && (
              <div className="mb-2 flex flex-wrap items-center gap-2 border-t-2 border-cardline pt-3">
                <p className="font-display text-sm font-extrabold text-ink">
                  🖨️ Printed {printedLabel(group.printedAt)}
                  <span className="ml-1 font-bold text-ink-soft">
                    · {group.orders.length} invoice{group.orders.length === 1 ? "" : "s"}
                  </span>
                </p>
                <Button
                  tone="ghost"
                  className="!px-3 !py-1.5 !text-xs sm:ml-auto"
                  onClick={() => selectOnly(group.orders.map((o) => o.id))}
                >
                  Select this batch
                </Button>
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {group.orders.map((o) => {
                const dups = duplicates.get(o.id);
                const manifest = manifestByOrder.get(o.id);
                return (
                  <div
                    key={o.id}
                    className={`flex min-h-14 items-start gap-3 rounded-xl border-2 px-3 py-2 font-display text-sm font-bold text-ink transition ${
                      dups
                        ? "border-flame bg-flame-tint/60"
                        : "border-transparent bg-cream/50 hover:border-frog/40 hover:bg-pond/50"
                    }`}
                  >
                    <input
                      id={`inv-${o.id}`}
                      type="checkbox"
                      checked={!excluded.has(o.id)}
                      onChange={() => toggle(o.id)}
                      className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-frog)]"
                    />
                    <label htmlFor={`inv-${o.id}`} className="min-w-0 flex-1 cursor-pointer">
                      <span className="block text-base text-ink">
                        {o.customer_name}
                        {o.order_no && <span className="ml-1 font-mono text-xs text-ink-soft">{o.order_no}</span>}
                      </span>
                      <span className="block break-words text-sm text-ink-soft">
                        {o.district} · {rs(o.total_cod)} · {manifest?.tracking_id}
                      </span>
                      {o.invoice_printed_at && (
                        <span className="mt-1 block text-xs font-extrabold text-frog-dark">
                          ✅ Printed {printedLabel(o.invoice_printed_at)}
                        </span>
                      )}
                      {dups && (
                        <span className="mt-1 block text-xs font-extrabold text-flame-dark">
                          ⚠️ Possible duplicate of {describeMatch(dups[0], eligibleIds.has(dups[0].order.id))}
                          {dups.length > 1 ? ` (+${dups.length - 1} more)` : ""}
                        </span>
                      )}
                    </label>
                    <div className="flex shrink-0 flex-col items-end">
                      <button
                        type="button"
                        onClick={() => setCancelTarget(o)}
                        aria-label={`Cancel order for ${o.customer_name}`}
                        title="Customer called it off before pickup — cancel and put the stock back"
                        className="min-h-11 rounded-xl px-2 font-display text-xs font-extrabold text-flame-dark transition hover:bg-flame-tint"
                      >
                        🚫 Cancel
                      </button>
                      {o.invoice_printed_at && (
                        <button
                          type="button"
                          disabled={marking}
                          onClick={() => void markPrinted([o.id], false)}
                          aria-label={`Mark invoice for ${o.customer_name} as not printed`}
                          title="Lost or spoiled? Put it back in “Not printed yet”."
                          className="min-h-11 rounded-xl px-2 font-display text-xs font-extrabold text-ink-soft transition hover:bg-pond"
                        >
                          ↩ Not printed
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            </div>
            ))}
          </Card>
        )}

        {selected.length > 0 && (
          <p className="font-display text-sm font-bold text-ink-soft sm:text-xs">
            <span className="sm:hidden">Tap Preview to inspect the exact A4 output before printing.</span>
            <span className="hidden sm:inline">👇 Print preview below — exactly what comes out of the printer.</span>
          </p>
        )}
      </div>

      {/* ── A4 sheets (the only thing that prints) ─────────────────── */}
      <div
        ref={previewRef}
        className={`${previewOpen ? "fixed inset-0 z-50 flex" : "hidden"} print-area flex-col bg-cream pb-[env(safe-area-inset-bottom)] sm:static sm:mx-auto sm:flex sm:w-full sm:items-center sm:gap-6 sm:bg-transparent sm:px-0 sm:pb-10 print:static print:flex print:bg-white print:pb-0`}
        role={previewOpen ? "dialog" : undefined}
        aria-modal={previewOpen ? true : undefined}
        aria-label={previewOpen ? "Invoice print preview" : undefined}
      >
        <div className="print-hide sticky top-0 z-10 flex w-full items-center justify-between border-b-2 border-cardline bg-surface px-4 py-3 sm:hidden">
          <div>
            <h2 className="font-display text-lg font-extrabold text-ink">Print preview</h2>
            <p className="text-sm font-semibold text-ink-soft">{selected.length} invoices · {sheets.length} {sheets.length === 1 ? "sheet" : "sheets"}</p>
          </div>
          <button ref={previewCloseRef} type="button" onClick={() => setPreviewOpen(false)} aria-label="Close invoice preview" className="flex h-11 w-11 items-center justify-center rounded-xl border-2 border-cardline bg-surface-soft font-display text-lg font-extrabold text-ink focus-visible:outline-2 focus-visible:outline-frog">✕</button>
        </div>
        <div className="print-hide flex w-full items-center justify-between border-b border-cardline bg-sky-tint px-4 py-2 sm:hidden">
          <p className="text-sm font-semibold text-sky-dark">Preview scaled to fit. Printing uses exact A4 size.</p>
          <Button tone="frog" onClick={() => window.print()} className="!px-3 !py-2 !text-sm">🖨️ Print</Button>
        </div>
        <div className="min-h-0 w-full flex-1 overflow-auto px-4 py-4 sm:contents print:contents">
          {settings &&
            sheets.map((sheet, i) => (
              <div key={i} className="invoice-sheet mx-auto [zoom:.35] min-[350px]:[zoom:.4] min-[390px]:[zoom:.44] min-[430px]:[zoom:.48] sm:[zoom:1] print:[zoom:1]">
              {sheet.map((order) => (
                <InvoiceCell
                  key={order.id}
                  order={order}
                  manifest={manifestByOrder.get(order.id)!}
                  settings={settings}
                  duplicate={duplicates.has(order.id)}
                />
              ))}
              {/* pad the last sheet so the grid keeps its shape */}
              {Array.from({ length: 8 - sheet.length }).map((_, j) => (
                <div key={`pad-${j}`} className="invoice-cell invoice-cell-empty" />
              ))}
              </div>
            ))}
        </div>
      </div>
      {printCheck && (
        <div
          role="dialog"
          aria-modal="false"
          aria-labelledby="print-check-title"
          className="print-hide fixed inset-x-0 bottom-0 z-[55] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:bottom-4 sm:left-1/2 sm:right-auto sm:w-[30rem] sm:-translate-x-1/2 sm:p-0"
        >
          <div className="rounded-2xl border-2 border-frog bg-surface p-4 shadow-2xl">
            <p id="print-check-title" className="font-display text-base font-extrabold text-ink">
              🖨️ Did all {printCheck.length} invoice{printCheck.length === 1 ? "" : "s"} print?
            </p>
            <p className="mt-1 text-sm font-semibold text-ink-soft">
              Yes moves them out of “Not printed yet”, so tomorrow you only see the rest.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button tone="ghost" disabled={marking} onClick={() => setPrintCheck(null)}>
                Not yet
              </Button>
              <Button tone="frog" disabled={marking} onClick={() => void markPrinted(printCheck, true)}>
                {marking ? "Saving…" : "Yes, mark printed"}
              </Button>
            </div>
          </div>
        </div>
      )}
      {cancelTarget && (
        <CancelOrderDialog
          order={cancelTarget}
          trackingId={manifestByOrder.get(cancelTarget.id)?.tracking_id}
          courierName={manifestByOrder.get(cancelTarget.id)?.courier_name}
          defaultReason={duplicates.has(cancelTarget.id) ? "Duplicate order" : undefined}
          onClose={() => setCancelTarget(null)}
          onCancelled={(updated) => {
            // Patch the one row locally — no need to re-read the batch.
            setOrders((prev) => prev.map((o) => (o.id === updated.id ? { ...o, ...updated } : o)));
            setCancelTarget(null);
          }}
        />
      )}
    </div>
  );
}

function InvoiceCell({
  order,
  manifest,
  settings,
  duplicate = false,
}: {
  order: Order;
  manifest: ShippingManifest;
  settings: BusinessSettings;
  duplicate?: boolean;
}) {
  const phones = [settings.business_phone_1, settings.business_phone_2]
    .filter(Boolean)
    .join(" / ");
  return (
    <div className={`invoice-cell${duplicate ? " invoice-cell-dup" : ""}`}>
      {/* On-screen only: the printed label must never carry the warning. */}
      {duplicate && <div className="inv-dup-badge print-hide">⚠️ Possible duplicate</div>}
      {/* Sender */}
      <div className="inv-head">
        <div>
          <div className="inv-biz">{settings.business_name || "—"}</div>
          {settings.business_address && <div className="inv-small">{settings.business_address}</div>}
          {phones && <div className="inv-small">☎ {phones}</div>}
        </div>
        <div className="inv-date">
          {new Date(order.created_at).toLocaleDateString("en-GB")}
          <br />
          {manifest.courier_name}
          {order.order_no && (
            <>
              <br />
              {order.order_no}
            </>
          )}
        </div>
      </div>

      <div className="inv-rule" />

      {/* Receiver */}
      <div className="inv-to">DELIVER TO</div>
      <div className="inv-cust">{order.customer_name}</div>
      <div className="inv-addr">
        {order.parsed_address}
        {order.city ? `, ${order.city}` : ""} · {order.district}
      </div>
      <div className="inv-phone">
        ☎ {[order.phone_number, order.phone_2].filter(Boolean).join(" / ")}
      </div>

      {/* Item + money */}
      <div className="inv-money">
        {(!order.items || order.items.length === 0) && (
          <div className="inv-item">{order.item_name || "Merchandise"}</div>
        )}
        <table className="inv-table">
          <tbody>
            {order.items && order.items.length > 0 ? (
              order.items.map((item, i) => (
                <tr key={i}>
                  <td>
                    {item.qty > 1 ? `${item.qty}× ` : ""}
                    {item.name}
                  </td>
                  <td>{rs(item.qty * item.price)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td>Item</td>
                <td>{rs(order.product_price)}</td>
              </tr>
            )}
            <tr>
              <td>Delivery</td>
              <td>{rs(order.shipping_fee)}</td>
            </tr>
            {order.discount > 0 && (
              <tr>
                <td>Discount</td>
                <td>-{rs(order.discount)}</td>
              </tr>
            )}
            <tr className="inv-total">
              <td>COD TOTAL</td>
              <td>{rs(order.total_cod)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Barcode */}
      <div className="inv-barcode">
        <Barcode value={manifest.tracking_id} className="inv-barcode-svg" />
        <div className="inv-tracking">{manifest.tracking_id}</div>
      </div>
    </div>
  );
}
