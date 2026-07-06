"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { DISTRICTS, shippingFeeFor } from "@/lib/districts";
import type { Order, OrderStatus, Product, ShippingManifest } from "@/lib/types";
import { Froggy } from "../components/froggy";
import { Button, Card } from "../components/ui";
import { CityPicker } from "../components/city-picker";

// Manual fallback flow: paste → parse → verify → save → book → copy.
// The realtime workspace at / replaces this for day-to-day work, but this page
// still handles orders that arrive outside WhatsApp and status bookkeeping.

interface ReviewForm {
  customer_name: string;
  phone_number: string;
  phone_2: string;
  parsed_address: string;
  city: string;
  district: string;
  product_id: string;
  item_name: string;
  product_price: string;
  shipping_fee: string;
  discount: string;
}

const STATUS_STYLE: Record<OrderStatus, string> = {
  pending: "bg-[#f2ede3] text-ink-soft",
  booked: "bg-sky-tint text-sky-dark",
  delivered: "bg-pond text-frog-dark",
  returned: "bg-flame-tint text-flame-dark",
};

const inputCls =
  "mt-1 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2 font-display text-sm font-bold text-ink outline-none focus:border-frog";

function confirmationBlock(order: Order, manifest?: ShippingManifest): string {
  const tracking = manifest ? `Tracking අංකය: ${manifest.tracking_id}.\n` : "";
  return (
    `Daily Cart එකෙන්! 🚚\n\n` +
    `ඔබගේ ඇණවුම සාර්ථකව තහවුරු කළා. ${tracking}` +
    `ලැබීමට ඇති මුදල: රු. ${order.total_cod}`
  );
}

export default function OrdersPage() {
  const [rawText, setRawText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [form, setForm] = useState<ReviewForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [manifests, setManifests] = useState<ShippingManifest[]>([]);
  const [usingSupabase, setUsingSupabase] = useState(true);
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [ordersRes, productsRes] = await Promise.all([
      fetch("/api/orders"),
      fetch("/api/products"),
    ]);
    const data = await ordersRes.json();
    if (ordersRes.ok) {
      setOrders(data.orders);
      setManifests(data.manifests);
      setUsingSupabase(data.usingSupabase);
    }
    const productsData = await productsRes.json();
    if (productsRes.ok) setProducts(productsData.products);
  }, []);

  const syncTracking = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/track/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSyncNote(
        data.checked === 0
          ? "Nothing riding with the courier right now."
          : `✅ ${data.delivered} delivered · ↩️ ${data.returned} returned · 🚚 ${data.inTransit} still moving` +
              (data.failures.length ? ` · ⚠️ ${data.failures.length} failed` : "")
      );
      await refresh();
    } catch (err) {
      setSyncNote(`⚠️ Sync failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  useEffect(() => {
    // Load, then pull the latest courier statuses once per visit.
    refresh().then(syncTracking);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleParse() {
    setParsing(true);
    setError(null);
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_text: rawText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setForm({
        customer_name: data.name,
        phone_number: data.phone,
        phone_2: data.phone_2 || "",
        parsed_address: data.address,
        city: data.city ?? "",
        district: data.district,
        product_id: "",
        item_name: "",
        product_price: "",
        shipping_fee: String(data.shipping_fee),
        discount: "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Parsing failed");
    } finally {
      setParsing(false);
    }
  }

  async function handleSave() {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          raw_address: rawText,
          product_price: Number(form.product_price || 0),
          shipping_fee: Number(form.shipping_fee || 0),
          discount: Number(form.discount || 0),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setForm(null);
      setRawText("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleBook(orderId: string) {
    setBookingId(orderId);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${orderId}/book`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.manifest?.pdf_label_url) {
        window.open(data.manifest.pdf_label_url, "_blank");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Booking failed");
    } finally {
      setBookingId(null);
    }
  }

  async function handleStatusChange(orderId: string, status: OrderStatus) {
    await fetch(`/api/orders/${orderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await refresh();
  }

  async function handleCopy(order: Order) {
    const manifest = manifests.find((m) => m.order_id === order.id);
    await navigator.clipboard.writeText(confirmationBlock(order, manifest));
    setCopiedId(order.id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  const setField = (field: keyof ReviewForm, value: string) => {
    setForm((f) => {
      if (!f) return f;
      const next = { ...f, [field]: value };
      if (field === "district") next.shipping_fee = String(shippingFeeFor(value));
      return next;
    });
  };

  const totalCod = form
    ? Math.max(
        0,
        Number(form.product_price || 0) +
          Number(form.shipping_fee || 0) -
          Number(form.discount || 0)
      )
    : 0;

  return (
    <main className="mx-auto max-w-5xl space-y-5 p-5 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Froggy mood={orders.length > 0 ? "happy" : "idle"} size={56} />
        <div>
          <h1 className="font-display text-2xl font-extrabold text-ink">Manual orders</h1>
          <p className="font-display text-sm font-bold text-ink-soft">
            Paste → parse → verify → book → copy confirmation
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button tone="grape" onClick={syncTracking} disabled={syncing}>
            {syncing ? "📡 Checking courier…" : "📡 Sync tracking"}
          </Button>
          <Link href="/invoices">
            <Button tone="sky">🖨️ Print invoices</Button>
          </Link>
        </div>
      </header>

      {syncNote && (
        <Card className="animate-pop p-3">
          <p className="font-display text-sm font-bold text-ink">{syncNote}</p>
        </Card>
      )}

      {!usingSupabase && (
        <Card className="!border-gold bg-gold/10 p-3">
          <p className="font-display text-xs font-bold text-ink">
            ⚠️ Running on the in-memory store — orders are lost on restart. Set DATABASE_URL in
            .env.local to persist.
          </p>
        </Card>
      )}

      {error && (
        <p className="rounded-xl border-2 border-[#f3c1c1] bg-[#fdecec] p-3 font-display text-sm font-bold text-[#c04545]">
          {error}
        </p>
      )}

      <Card className="p-5">
        <h2 className="mb-2 font-display text-lg font-extrabold text-ink">
          1 · Paste raw WhatsApp text
        </h2>
        <textarea
          className="h-32 w-full rounded-xl border-2 border-cardline bg-cream/60 p-3 text-sm font-semibold text-ink outline-none focus:border-frog"
          placeholder="Paste the customer's address message here…"
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
        />
        <Button
          tone="grape"
          onClick={handleParse}
          disabled={parsing || !rawText.trim()}
          className="mt-3"
        >
          {parsing ? "🤔 Parsing…" : "🪄 Parse with AI"}
        </Button>
      </Card>

      {form && (
        <Card className="animate-pop p-5">
          <h2 className="mb-3 font-display text-lg font-extrabold text-ink">2 · Verify &amp; save</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="font-display text-xs font-bold text-ink-soft">
              Name
              <input
                className={inputCls}
                value={form.customer_name}
                onChange={(e) => setField("customer_name", e.target.value)}
              />
            </label>
            <label className="font-display text-xs font-bold text-ink-soft">
              Phone
              <input
                className={inputCls}
                value={form.phone_number}
                onChange={(e) => setField("phone_number", e.target.value)}
              />
            </label>
            <label className="font-display text-xs font-bold text-ink-soft">
              Phone 2 (optional)
              <input
                className={inputCls}
                value={form.phone_2}
                onChange={(e) => setField("phone_2", e.target.value)}
              />
            </label>
            <label className="font-display text-xs font-bold text-ink-soft sm:col-span-2">
              Address
              <input
                className={inputCls}
                value={form.parsed_address}
                onChange={(e) => setField("parsed_address", e.target.value)}
              />
            </label>
            <label className="font-display text-xs font-bold text-ink-soft">
              City / Town
              <CityPicker
                className={inputCls}
                value={form.city}
                onChange={(city) => setForm((f) => (f ? { ...f, city } : f))}
              />
            </label>
            <label className="font-display text-xs font-bold text-ink-soft">
              District
              <select
                className={inputCls}
                value={form.district}
                onChange={(e) => setField("district", e.target.value)}
              >
                {DISTRICTS.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
            {products.length > 0 && (
              <div className="sm:col-span-2">
                <p className="mb-1 font-display text-xs font-bold text-ink-soft">
                  Product (tap to fill)
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {products.map((p) => {
                    const active = form.product_id === p.id;
                    const out = p.stock_units <= 0;
                    return (
                      <button
                        key={p.id}
                        onClick={() =>
                          setForm((f) =>
                            f
                              ? {
                                  ...f,
                                  product_id: p.id,
                                  item_name: p.name,
                                  product_price: String(p.price),
                                }
                              : f
                          )
                        }
                        className={
                          "rounded-full px-2.5 py-1 font-display text-xs font-bold transition " +
                          (active
                            ? "bg-frog text-white"
                            : "bg-[#f2ede3] text-ink hover:bg-pond hover:text-frog-dark")
                        }
                      >
                        {p.name} · Rs. {p.price}{" "}
                        <span className={out ? "text-[#c04545]" : active ? "text-white/80" : "text-ink-soft"}>
                          ({out ? "out of stock!" : `${p.stock_units} left`})
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <label className="font-display text-xs font-bold text-ink-soft">
              Item name (prints on the invoice)
              <input
                className={inputCls}
                value={form.item_name}
                onChange={(e) =>
                  setForm((f) => (f ? { ...f, item_name: e.target.value, product_id: "" } : f))
                }
                placeholder="e.g. Posture corrector"
              />
            </label>
            <label className="font-display text-xs font-bold text-ink-soft">
              Product price (Rs.)
              <input
                type="number"
                className={inputCls}
                value={form.product_price}
                onChange={(e) => setField("product_price", e.target.value)}
              />
            </label>
            <label className="font-display text-xs font-bold text-ink-soft">
              Shipping (Rs.)
              <input
                type="number"
                className={inputCls}
                value={form.shipping_fee}
                onChange={(e) => setField("shipping_fee", e.target.value)}
              />
            </label>
            <label className="font-display text-xs font-bold text-ink-soft">
              Discount (Rs.)
              <input
                type="number"
                className={inputCls}
                value={form.discount}
                onChange={(e) => setField("discount", e.target.value)}
              />
            </label>
            <div className="flex items-end rounded-xl bg-gold/15 px-3 py-2 font-display text-sm font-extrabold text-ink">
              Total COD: Rs. {totalCod}
            </div>
          </div>
          <Button tone="frog" onClick={handleSave} disabled={saving} className="mt-4">
            {saving ? "Saving…" : "💾 Save order"}
          </Button>
        </Card>
      )}

      <Card className="p-5">
        <h2 className="mb-3 font-display text-lg font-extrabold text-ink">3 · Orders</h2>
        {orders.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center">
            <Froggy mood="sleepy" size={72} />
            <p className="font-display text-sm font-bold text-ink-soft">No orders yet.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b-2 border-cardline font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">
                  <th className="py-2 pr-3">Customer</th>
                  <th className="py-2 pr-3">District</th>
                  <th className="py-2 pr-3">COD</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">Tracking</th>
                  <th className="py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const manifest = manifests.find((m) => m.order_id === order.id);
                  return (
                    <tr key={order.id} className="border-b border-cardline/60 align-top">
                      <td className="py-2.5 pr-3">
                        <div className="font-display font-bold text-ink">
                          {order.customer_name}
                        </div>
                        <div className="text-xs font-semibold text-ink-soft">
                          {[order.phone_number, order.phone_2].filter(Boolean).join(" / ")}
                        </div>
                      </td>
                      <td className="py-2.5 pr-3 font-semibold text-ink">{order.district}</td>
                      <td className="py-2.5 pr-3 font-display font-bold text-ink">
                        Rs. {order.total_cod}
                      </td>
                      <td className="py-2.5 pr-3">
                        <select
                          className={
                            "rounded-full border-0 px-2 py-1 font-display text-xs font-extrabold outline-none " +
                            STATUS_STYLE[order.order_status]
                          }
                          value={order.order_status}
                          onChange={(e) =>
                            handleStatusChange(order.id, e.target.value as OrderStatus)
                          }
                        >
                          <option value="pending">pending</option>
                          <option value="booked">booked</option>
                          <option value="delivered">delivered</option>
                          <option value="returned">returned</option>
                        </select>
                      </td>
                      <td className="py-2.5 pr-3">
                        {manifest ? (
                          <>
                            <div className="font-mono text-xs font-bold text-ink">
                              {manifest.tracking_id}
                            </div>
                            {manifest.pdf_label_url && (
                              <a
                                href={manifest.pdf_label_url}
                                target="_blank"
                                className="text-xs font-bold text-sky-dark underline"
                              >
                                Label PDF
                              </a>
                            )}
                          </>
                        ) : (
                          <span className="text-ink-soft">—</span>
                        )}
                      </td>
                      <td className="py-2.5">
                        <div className="flex gap-2">
                          {order.order_status === "pending" && (
                            <Button
                              tone="frog"
                              onClick={() => handleBook(order.id)}
                              disabled={bookingId === order.id}
                              className="!px-3 !py-1.5 !text-xs"
                            >
                              {bookingId === order.id ? "Booking…" : "🚀 Book"}
                            </Button>
                          )}
                          <Button
                            tone="ghost"
                            onClick={() => handleCopy(order)}
                            className="!px-3 !py-1.5 !text-xs"
                          >
                            {copiedId === order.id ? "Copied ✓" : "Copy confirm"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </main>
  );
}
