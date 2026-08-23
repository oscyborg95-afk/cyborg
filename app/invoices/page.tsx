"use client";

// Batch invoice printing: pick a day or range, get every booked order as 8-up A4 sheets
// (2 × 4 per page), each with the business block, customer block, item, COD
// breakdown and a scannable Code-128 barcode of the courier tracking ID.
// Browser print → save the whole batch as one PDF or send straight to paper.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BusinessSettings, Order, ShippingManifest } from "@/lib/types";
import { Barcode } from "../components/barcode";
import { Froggy } from "../components/froggy";
import { Button, Card } from "../components/ui";

const rs = (n: number) => `Rs. ${Math.round(n).toLocaleString("en-LK")}`;
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA"); // YYYY-MM-DD

type DateFilterMode = "single" | "range" | "all";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function InvoicesPage() {
  const today = useMemo(() => new Date().toLocaleDateString("en-CA"), []);
  const [orders, setOrders] = useState<Order[]>([]);
  const [manifests, setManifests] = useState<ShippingManifest[]>([]);
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [filterMode, setFilterMode] = useState<DateFilterMode>("single");
  const [date, setDate] = useState(today);
  const [rangeFrom, setRangeFrom] = useState(today);
  const [rangeTo, setRangeTo] = useState(today);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewCloseRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    const [ordersRes, settingsRes] = await Promise.all([
      fetch("/api/orders"),
      fetch("/api/settings"),
    ]);
    const ordersData = await ordersRes.json();
    const settingsData = await settingsRes.json();
    if (ordersRes.ok) {
      setOrders(ordersData.orders);
      setManifests(ordersData.manifests);
    }
    if (settingsRes.ok) setSettings(settingsData.settings);
    setLoaded(true);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

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

  const rangeIsValid = Boolean(rangeFrom && rangeTo && rangeFrom <= rangeTo);

  // Printable = has a tracking ID (was actually handed to the courier).
  const eligible = useMemo(
    () =>
      orders
        .filter((o) => manifestByOrder.has(o.id))
        .filter((o) => {
          if (filterMode === "all") return true;

          const orderDay = localDay(o.created_at);
          if (filterMode === "single") return orderDay === date;
          return rangeIsValid && orderDay >= rangeFrom && orderDay <= rangeTo;
        })
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [orders, manifestByOrder, filterMode, date, rangeFrom, rangeTo, rangeIsValid]
  );

  const selected = eligible.filter((o) => !excluded.has(o.id));
  const sheets = chunk(selected, 8);

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const missingProfile =
    settings && !settings.business_name && !settings.business_address ? true : false;

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
              Invoice dates
            </legend>
            <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
              {([
                ["single", "Single day"],
                ["range", "Date range"],
                ["all", "All days"],
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
          </span>
          <div className="grid grid-cols-2 gap-2 sm:ml-auto sm:flex">
            <Button tone="sky" className="sm:hidden" disabled={selected.length === 0} onClick={() => setPreviewOpen(true)}>
              👀 Preview
            </Button>
            <Button tone="frog" disabled={selected.length === 0} onClick={() => window.print()}>
              🖨️ <span className="sm:hidden">Print</span><span className="hidden sm:inline">Print / Save PDF</span>
            </Button>
          </div>
        </Card>

        {loaded && eligible.length === 0 && (
          <Card className="flex flex-col items-center gap-3 p-10 text-center">
            <Froggy mood="sleepy" size={90} />
            <p className="font-display text-lg font-extrabold text-ink">
              {filterMode === "all"
                ? "No shipped orders yet"
                : filterMode === "range"
                  ? rangeIsValid
                    ? "No shipped orders in this date range"
                    : "This date range is invalid"
                  : "No shipped orders on this day"}
            </p>
            <p className="font-display text-sm font-bold text-ink-soft">
              Invoices appear here once orders are dispatched with a tracking ID.
            </p>
          </Card>
        )}

        {eligible.length > 0 && (
          <Card className="p-4">
            <p className="mb-2 font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">
              Include / exclude
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {eligible.map((o) => (
                <label
                  key={o.id}
                  className="flex min-h-14 items-start gap-3 rounded-xl border-2 border-transparent bg-cream/50 px-3 py-2 font-display text-sm font-bold text-ink transition hover:border-frog/40 hover:bg-pond/50"
                >
                  <input
                    type="checkbox"
                    checked={!excluded.has(o.id)}
                    onChange={() => toggle(o.id)}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--color-frog)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-base text-ink">{o.customer_name}</span>
                    <span className="block break-words text-sm text-ink-soft">
                      {o.district} · {rs(o.total_cod)} · {manifestByOrder.get(o.id)?.tracking_id}
                    </span>
                  </span>
                </label>
              ))}
            </div>
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
    </div>
  );
}

function InvoiceCell({
  order,
  manifest,
  settings,
}: {
  order: Order;
  manifest: ShippingManifest;
  settings: BusinessSettings;
}) {
  const phones = [settings.business_phone_1, settings.business_phone_2]
    .filter(Boolean)
    .join(" / ");
  return (
    <div className="invoice-cell">
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
