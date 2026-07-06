"use client";

// Batch invoice printing: pick a day, get every booked order as 8-up A4 sheets
// (2 × 4 per page), each with the business block, customer block, item, COD
// breakdown and a scannable Code-128 barcode of the courier tracking ID.
// Browser print → save the whole batch as one PDF or send straight to paper.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BusinessSettings, Order, ShippingManifest } from "@/lib/types";
import { Barcode } from "../components/barcode";
import { Froggy } from "../components/froggy";
import { Button, Card } from "../components/ui";

const rs = (n: number) => `Rs. ${Math.round(n).toLocaleString("en-LK")}`;
const localDay = (iso: string) => new Date(iso).toLocaleDateString("en-CA"); // YYYY-MM-DD

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function InvoicesPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [manifests, setManifests] = useState<ShippingManifest[]>([]);
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [allDates, setAllDates] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);

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
    load();
  }, [load]);

  const manifestByOrder = useMemo(() => {
    const map = new Map<string, ShippingManifest>();
    for (const m of manifests) map.set(m.order_id, m);
    return map;
  }, [manifests]);

  // Printable = has a tracking ID (was actually handed to the courier).
  const eligible = useMemo(
    () =>
      orders
        .filter((o) => manifestByOrder.has(o.id))
        .filter((o) => allDates || localDay(o.created_at) === date)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [orders, manifestByOrder, allDates, date]
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
      <div className="print-hide mx-auto max-w-5xl space-y-4 p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <Froggy mood={selected.length > 0 ? "happy" : "idle"} size={56} />
          <div>
            <h1 className="font-display text-2xl font-extrabold text-ink">Invoice printer</h1>
            <p className="font-display text-sm font-bold text-ink-soft">
              8 invoices per A4 sheet · print or save the whole day as one PDF
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

        <Card className="flex flex-wrap items-center gap-4 p-4">
          <label className="font-display text-sm font-bold text-ink-soft">
            Day
            <input
              type="date"
              value={date}
              disabled={allDates}
              onChange={(e) => setDate(e.target.value)}
              className="ml-2 rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2 font-display text-sm font-bold text-ink outline-none focus:border-frog disabled:opacity-40"
            />
          </label>
          <label className="flex items-center gap-2 font-display text-sm font-bold text-ink-soft">
            <input
              type="checkbox"
              checked={allDates}
              onChange={(e) => setAllDates(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-frog)]"
            />
            All days
          </label>
          <span className="font-display text-sm font-bold text-ink">
            {selected.length} of {eligible.length} shipments selected · {sheets.length}{" "}
            {sheets.length === 1 ? "sheet" : "sheets"}
          </span>
          <Button
            tone="frog"
            className="ml-auto"
            disabled={selected.length === 0}
            onClick={() => window.print()}
          >
            🖨️ Print / Save PDF
          </Button>
        </Card>

        {loaded && eligible.length === 0 && (
          <Card className="flex flex-col items-center gap-3 p-10 text-center">
            <Froggy mood="sleepy" size={90} />
            <p className="font-display text-lg font-extrabold text-ink">
              No shipped orders {allDates ? "yet" : "on this day"}
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
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {eligible.map((o) => (
                <label
                  key={o.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1 font-display text-sm font-bold text-ink hover:bg-pond/50"
                >
                  <input
                    type="checkbox"
                    checked={!excluded.has(o.id)}
                    onChange={() => toggle(o.id)}
                    className="h-4 w-4 accent-[var(--color-frog)]"
                  />
                  {o.customer_name}
                  <span className="text-ink-soft">
                    · {o.district} · {rs(o.total_cod)} · {manifestByOrder.get(o.id)?.tracking_id}
                  </span>
                </label>
              ))}
            </div>
          </Card>
        )}

        {selected.length > 0 && (
          <p className="font-display text-xs font-bold text-ink-soft">
            👇 Print preview below — exactly what comes out of the printer.
          </p>
        )}
      </div>

      {/* ── A4 sheets (the only thing that prints) ─────────────────── */}
      <div className="print-area mx-auto flex flex-col items-center gap-6 pb-10">
        {settings &&
          sheets.map((sheet, i) => (
            <div key={i} className="invoice-sheet">
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
