"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DISTRICTS, shippingFeeFor } from "@/lib/districts";
import { makeTemplates } from "@/lib/templates";
import { itemsSubtotal } from "@/lib/items";
import { phoneToChatId } from "@/lib/phone";
import {
  customerRisk,
  findDuplicates,
  duplicateOrderIds,
  recentOrdersForPhone,
} from "@/lib/risk";
import type {
  AlertKind,
  CustomerAlert,
  MessageTemplates,
  Order,
  OrderItem,
  OrderStatus,
  Product,
  ShippingManifest,
  TrackingHealth,
  TrackingEvent,
} from "@/lib/types";
import { Froggy } from "../components/froggy";
import { Button, Card } from "../components/ui";
import { CityPicker } from "../components/city-picker";
import { ItemsEditor } from "../components/items-editor";
import { RemittancePanel } from "../components/remittance-panel";

// Manual fallback flow: paste → parse → verify → save → book → copy.
// The realtime workspace at / replaces this for day-to-day work, but this page
// still handles orders that arrive outside WhatsApp and status bookkeeping.

interface ReviewForm {
  customer_name: string;
  phone_number: string;
  phone_2: string;
  parsed_address: string;
  city: string;
  city_id: number | null; // exact courier city id from the picker; null → resolve by name
  district: string;
  items: OrderItem[]; // multi-product cart — subtotal feeds the COD total
  shipping_fee: string;
  discount: string;
}

const STATUS_STYLE: Record<OrderStatus, string> = {
  pending: "bg-[#f2ede3] text-ink-soft",
  booked: "bg-sky-tint text-sky-dark",
  delivered: "bg-pond text-frog-dark",
  returned: "bg-flame-tint text-flame-dark",
};

// Customer tracking alerts — friendly label per kind, and which order status
// each one is naturally sent at (used to decide which send buttons to surface).
const ALERT_LABELS: Record<AlertKind, string> = {
  out_for_delivery: "🛵 Out for delivery",
  delivered: "💚 Delivered thank-you",
  returned: "↩️ Redeliver offer",
};
const ALERT_FOR_STATUS: Record<AlertKind, OrderStatus> = {
  out_for_delivery: "booked",
  delivered: "delivered",
  returned: "returned",
};

const inputCls =
  "mt-1 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2 font-display text-sm font-bold text-ink outline-none focus:border-frog";

function confirmationBlock(
  order: Order,
  manifest?: ShippingManifest,
  overrides: MessageTemplates = {}
): string {
  return makeTemplates(overrides).shippedConfirmation(order.total_cod, manifest?.tracking_id);
}

// Visual style for each timeline outcome.
const OUTCOME_STYLE: Record<string, { dot: string; label: string; emoji: string }> = {
  booked: { dot: "bg-sky", label: "Booked", emoji: "📦" },
  in_transit: { dot: "bg-gold", label: "In transit", emoji: "🚚" },
  delivered: { dot: "bg-frog", label: "Delivered", emoji: "✅" },
  returned: { dot: "bg-flame", label: "Returned", emoji: "↩️" },
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Everything the accountant (i.e. you, at month end) wants, one row per order.
function ordersToCsv(orders: Order[], manifests: ShippingManifest[]): string {
  const manifestByOrder = new Map(manifests.map((m) => [m.order_id, m]));
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const header = [
    "created_at",
    "order_no",
    "customer_name",
    "phone",
    "phone_2",
    "address",
    "city",
    "district",
    "items",
    "product_total",
    "shipping_fee",
    "discount",
    "total_cod",
    "status",
    "tracking_id",
    "courier",
    "remitted_at",
  ];
  const rows = orders.map((o) => {
    const m = manifestByOrder.get(o.id);
    return [
      o.created_at,
      o.order_no ?? "",
      o.customer_name,
      o.phone_number,
      o.phone_2,
      o.parsed_address,
      o.city,
      o.district,
      o.items && o.items.length > 0
        ? o.items.map((i) => `${i.qty}x ${i.name} @${i.price}`).join("; ")
        : o.item_name,
      o.product_price,
      o.shipping_fee,
      o.discount,
      o.total_cod,
      o.order_status,
      m?.tracking_id ?? "",
      m?.courier_name ?? "",
      o.remitted_at ?? "",
    ]
      .map(esc)
      .join(",");
  });
  return [header.join(","), ...rows].join("\n");
}

export default function OrdersPage() {
  const [rawText, setRawText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [form, setForm] = useState<ReviewForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [manifests, setManifests] = useState<ShippingManifest[]>([]);
  const [events, setEvents] = useState<TrackingEvent[]>([]);
  const [alerts, setAlerts] = useState<CustomerAlert[]>([]);
  const [alertBusy, setAlertBusy] = useState<string | null>(null); // `${orderId}:${kind}`
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [usingSupabase, setUsingSupabase] = useState(true);
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [msgTemplates, setMsgTemplates] = useState<MessageTemplates>({});
  const [search, setSearch] = useState("");
  const [redeliverSentId, setRedeliverSentId] = useState<string | null>(null);
  const [rebookingId, setRebookingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [trackingHealth, setTrackingHealth] = useState<TrackingHealth | null>(null);

  const refresh = useCallback(async () => {
    const [ordersRes, productsRes, settingsRes, healthRes] = await Promise.all([
      fetch("/api/orders"),
      fetch("/api/products"),
      fetch("/api/settings"),
      fetch("/api/tracking/health"),
    ]);
    const data = await ordersRes.json();
    if (ordersRes.ok) {
      setOrders(data.orders);
      setManifests(data.manifests);
      setEvents(data.events ?? []);
      setAlerts(data.alerts ?? []);
      setUsingSupabase(data.usingSupabase);
    }
    const productsData = await productsRes.json();
    if (productsRes.ok) setProducts(productsData.products);
    const settingsData = await settingsRes.json();
    if (settingsRes.ok) setMsgTemplates(settingsData.settings?.templates ?? {});
    const healthData = await healthRes.json();
    if (healthRes.ok) setTrackingHealth(healthData.health);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
        city_id: null, // parser returns a name only; operator picks the exact city
        district: data.district,
        items: [],
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
          shipping_fee: Number(form.shipping_fee || 0),
          discount: Number(form.discount || 0),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setForm(null);
      setRawText("");
      setShowManual(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleBook(orderId: string) {
    // Last line of defence against shipping the same parcel twice: if this
    // customer already has another recent, un-returned order, make the operator
    // confirm before a second courier booking goes out.
    const order = orders.find((o) => o.id === orderId);
    if (order) {
      const dups = findDuplicates(orders, order);
      if (dups.length > 0) {
        const lines = dups
          .slice(0, 4)
          .map((d) => {
            const ref = d.order.order_no || d.order.id.slice(0, 8);
            const when =
              d.hoursApart < 1 ? "just now" : `${Math.round(d.hoursApart)}h earlier`;
            const flags = [
              d.alreadyShipped ? `already ${d.order.order_status}` : d.order.order_status,
              d.sameItem ? "same item" : "different item",
            ].join(", ");
            return `• ${ref} — Rs. ${d.order.total_cod} (${flags}, ${when})`;
          })
          .join("\n");
        const shipped = dups.some((d) => d.alreadyShipped);
        const ok = confirm(
          `⚠️ Possible duplicate for ${order.customer_name} (${order.phone_number}).\n\n` +
            `This customer already has ${dups.length} recent order${dups.length > 1 ? "s" : ""}:\n${lines}\n\n` +
            (shipped
              ? "One of them has ALREADY shipped — booking this too means two parcels go out.\n\n"
              : "") +
            "Book and ship this one anyway?"
        );
        if (!ok) return;
      }
    }
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

  // Manually (re)send a tracking alert to the customer. Confirms first if it has
  // already been sent, so a resend is always deliberate.
  async function handleSendAlert(order: Order, kind: AlertKind, alreadySent: boolean) {
    const label = ALERT_LABELS[kind];
    if (
      alreadySent &&
      !confirm(
        `The "${label}" message was already sent to ${order.customer_name}.\n\nSend it again?`
      )
    )
      return;
    setAlertBusy(`${order.id}:${kind}`);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Couldn't send the ${label} message`);
    } finally {
      setAlertBusy(null);
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
    await navigator.clipboard.writeText(confirmationBlock(order, manifest, msgTemplates));
    setCopiedId(order.id);
    setTimeout(() => setCopiedId(null), 1500);
  }

  // --- Return workflow: apology message + one-click second attempt ----------

  async function handleRedeliverOffer(order: Order) {
    setError(null);
    try {
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: phoneToChatId(order.phone_number),
          text: makeTemplates(msgTemplates).returnedApology(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRedeliverSentId(order.id);
      setTimeout(() => setRedeliverSentId(null), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    }
  }

  async function handleRebook(order: Order) {
    if (!confirm(`Re-book for ${order.customer_name} (Rs. ${order.total_cod})? A fresh pending order is created — book it when the customer confirms.`))
      return;
    setRebookingId(order.id);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/rebook`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-book failed");
    } finally {
      setRebookingId(null);
    }
  }

  async function handleDelete(order: Order) {
    const ref = order.order_no ? `${order.order_no} — ` : "";
    if (
      !confirm(
        `Archive order ${ref}${order.customer_name} (Rs. ${order.total_cod})?\n\nIt will leave the operational list, but its tracking, stock, and financial history will be preserved.`
      )
    )
      return;
    setDeletingId(order.id);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${order.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (expandedId === order.id) setExpandedId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Archive failed");
    } finally {
      setDeletingId(null);
    }
  }

  // Orders that share a customer + a 72h window with another live order — the
  // set the list badges as "possible duplicate".
  const dupIds = useMemo(() => duplicateOrderIds(orders), [orders]);

  // --- Cash reconciliation ---------------------------------------------------

  const unremitted = orders.filter((o) => o.order_status === "delivered" && !o.remitted_at);
  const unremittedTotal = unremitted.reduce((sum, o) => sum + Number(o.total_cod), 0);

  function handleExportCsv() {
    const csv = ordersToCsv(orders, manifests);
    // BOM so Excel opens the Sinhala names correctly.
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `daily-cart-orders-${new Date().toLocaleDateString("en-CA")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const setField = (field: Exclude<keyof ReviewForm, "items" | "city_id">, value: string) => {
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
        itemsSubtotal(form.items) + Number(form.shipping_fee || 0) - Number(form.discount || 0)
      )
    : 0;

  return (
    <main className="mx-auto max-w-5xl space-y-5 p-5 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <Froggy mood={orders.length > 0 ? "happy" : "idle"} size={56} />
        <div>
          <h1 className="font-display text-2xl font-extrabold text-ink">Orders &amp; tracking</h1>
          <p className="font-display text-sm font-bold text-ink-soft">
            Every order, its courier status, and the full delivery timeline
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            tone={showManual ? "ghost" : "gold"}
            onClick={() => {
              setShowManual((v) => !v);
              if (showManual) {
                setForm(null);
                setRawText("");
              }
            }}
          >
            {showManual ? "✕ Close" : "＋ Add manual order"}
          </Button>
          <Button tone="grape" onClick={syncTracking} disabled={syncing}>
            {syncing ? "📡 Checking courier…" : "📡 Sync tracking"}
          </Button>
          <Button tone="ghost" onClick={handleExportCsv} disabled={orders.length === 0}>
            📄 Export CSV
          </Button>
          <Link href="/invoices">
            <Button tone="sky">🖨️ Print invoices</Button>
          </Link>
        </div>
      </header>

      <RemittancePanel
        outstandingCount={unremitted.length}
        outstandingGross={unremittedTotal}
        onRecorded={async (message) => {
          setSyncNote(message);
          await refresh();
        }}
      />

      {trackingHealth && <TrackingHealthPanel health={trackingHealth} />}

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

      {showManual && (
        <>
      <Card className="p-5">
        <h2 className="mb-2 font-display text-lg font-extrabold text-ink">
          Paste raw text
        </h2>
        <p className="mb-2 font-display text-xs font-bold text-ink-soft">
          For orders that didn&apos;t arrive on WhatsApp (a phone call, Instagram, a walk-in).
          WhatsApp chats parse automatically in the workspace — you don&apos;t need this for those.
        </p>
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
              {form.phone_number.replace(/\D/g, "").length >= 9 &&
                (() => {
                  const risk = customerRisk(orders, form.phone_number);
                  return (
                    <span
                      className={
                        "mt-1 inline-block rounded-full px-2 py-0.5 font-display text-[10px] font-extrabold " +
                        (risk.tier === "risky"
                          ? "bg-flame-tint text-flame-dark"
                          : risk.tier === "watch"
                            ? "bg-gold/25 text-gold-dark"
                            : risk.tier === "good"
                              ? "bg-pond text-frog-dark"
                              : "bg-[#f2ede3] text-ink-soft")
                      }
                    >
                      {risk.emoji} {risk.label}
                    </span>
                  );
                })()}
              {form.phone_number.replace(/\D/g, "").length >= 9 &&
                (() => {
                  const recent = recentOrdersForPhone(orders, form.phone_number);
                  if (recent.length === 0) return null;
                  const r = recent[0];
                  const ref = r.order_no || r.id.slice(0, 8);
                  return (
                    <div className="mt-1.5 rounded-lg border-2 border-flame/40 bg-flame-tint px-2.5 py-1.5 font-display text-[11px] font-bold text-flame-dark">
                      ⚠️ This number already has {recent.length} recent order
                      {recent.length > 1 ? "s" : ""} ({ref}
                      {recent.length > 1 ? " +more" : ""}, {r.order_status}). Make sure this isn&rsquo;t
                      the same order before saving.
                    </div>
                  );
                })()}
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
                onChange={(city, cityId) =>
                  setForm((f) => (f ? { ...f, city, city_id: cityId } : f))
                }
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
            <div className="sm:col-span-2">
              <ItemsEditor
                products={products}
                items={form.items}
                onChange={(items) => setForm((f) => (f ? { ...f, items } : f))}
              />
            </div>
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
        </>
      )}

      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-display text-lg font-extrabold text-ink">Orders</h2>
          <input
            className="ml-auto w-full max-w-xs rounded-xl border-2 border-cardline bg-cream/60 px-3 py-1.5 text-sm font-semibold text-ink outline-none focus:border-frog"
            placeholder="🔎 Search name, phone, tracking…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
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
                {orders
                  .filter((order) => {
                    const q = search.trim().toLowerCase();
                    if (!q) return true;
                    const manifest = manifests.find((m) => m.order_id === order.id);
                    return [
                      order.customer_name,
                      order.phone_number,
                      order.phone_2,
                      order.city,
                      order.district,
                      order.item_name,
                      order.order_status,
                      manifest?.tracking_id ?? "",
                    ]
                      .join(" ")
                      .toLowerCase()
                      .includes(q);
                  })
                  .map((order) => {
                  const manifest = manifests.find((m) => m.order_id === order.id);
                  const orderEvents = events
                    .filter((e) => e.order_id === order.id)
                    .sort((a, b) => a.created_at.localeCompare(b.created_at));
                  const latest = orderEvents[orderEvents.length - 1];
                  const latestStyle = latest ? OUTCOME_STYLE[latest.outcome] : null;
                  const expanded = expandedId === order.id;
                  const orderAlerts = alerts.filter((a) => a.order_id === order.id);
                  // Expandable when there's a timeline OR any customer alert to
                  // review/resend, so alert history is never stranded.
                  const trackable = Boolean(manifest || orderEvents.length || orderAlerts.length);
                  return (
                    <Fragment key={order.id}>
                      <tr className="border-b border-cardline/60 align-top">
                        <td className="py-2.5 pr-3">
                          <div className="font-display font-bold text-ink">
                            {order.customer_name}
                          </div>
                          <div className="text-xs font-semibold text-ink-soft">
                            {[order.phone_number, order.phone_2].filter(Boolean).join(" / ")}
                          </div>
                          {order.order_no && (
                            <div className="mt-0.5 font-mono text-[11px] font-bold text-ink-soft">
                              {order.order_no}
                            </div>
                          )}
                          {dupIds.has(order.id) && (
                            <div
                              className="mt-1 inline-block rounded-full bg-flame-tint px-2 py-0.5 font-display text-[10px] font-extrabold text-flame-dark"
                              title="Another live order from this customer was raised within 72h — check it isn't the same parcel."
                            >
                              ⚠️ Possible duplicate
                            </div>
                          )}
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
                          {order.order_status === "delivered" && (
                            <div className="mt-0.5 font-display text-[10px] font-extrabold text-ink-soft">
                              {order.remitted_at ? "💵 paid out" : "⏳ awaiting payout"}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 pr-3">
                          {manifest ? (
                            <>
                              <div className="font-mono text-xs font-bold text-ink">
                                {manifest.tracking_id}
                              </div>
                              {latestStyle && (
                                <div className="mt-0.5 font-display text-xs font-bold text-ink-soft">
                                  {latestStyle.emoji} {latest.checkpoint}
                                </div>
                              )}
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
                          <div className="flex flex-wrap gap-2">
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
                            {order.order_status === "returned" && (
                              <>
                                <Button
                                  tone="gold"
                                  onClick={() => handleRedeliverOffer(order)}
                                  className="!px-3 !py-1.5 !text-xs"
                                >
                                  {redeliverSentId === order.id ? "Sent ✓" : "💬 Redeliver offer"}
                                </Button>
                                <Button
                                  tone="sky"
                                  onClick={() => handleRebook(order)}
                                  disabled={rebookingId === order.id}
                                  className="!px-3 !py-1.5 !text-xs"
                                >
                                  {rebookingId === order.id ? "Cloning…" : "🔁 Re-book"}
                                </Button>
                              </>
                            )}
                            {trackable && (
                              <Button
                                tone="ghost"
                                onClick={() => setExpandedId(expanded ? null : order.id)}
                                className="!px-3 !py-1.5 !text-xs"
                              >
                                {expanded ? "Hide timeline ▲" : "🧭 Timeline ▾"}
                              </Button>
                            )}
                            <Button
                              tone="ghost"
                              onClick={() => handleCopy(order)}
                              className="!px-3 !py-1.5 !text-xs"
                            >
                              {copiedId === order.id ? "Copied ✓" : "Copy confirm"}
                            </Button>
                            <button
                              onClick={() => handleDelete(order)}
                              disabled={
                                deletingId === order.id ||
                                order.order_status === "booked" ||
                                (order.order_status === "delivered" && !order.remitted_at)
                              }
                              title={
                                order.order_status === "booked"
                                  ? "Wait until the courier delivers or returns this order"
                                  : order.order_status === "delivered" && !order.remitted_at
                                    ? "Record the COD payout before archiving"
                                    : "Archive order"
                              }
                              className="rounded-xl px-3 py-1.5 font-display text-xs font-bold text-ink-soft transition hover:bg-flame-tint hover:text-[#c04545] disabled:opacity-50"
                            >
                              {deletingId === order.id ? "Archiving…" : "🗄 Archive"}
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-b border-cardline/60 bg-cream/40">
                          <td colSpan={6} className="px-4 py-4">
                            <Timeline events={orderEvents} manifest={manifest} />
                            <AlertsPanel
                              order={order}
                              alerts={orderAlerts}
                              busyKey={alertBusy}
                              onSend={handleSendAlert}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
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

function TrackingHealthPanel({ health }: { health: TrackingHealth }) {
  const phoneLink = (phone: string) => {
    const digits = phone.replace(/\D/g, "");
    return `https://wa.me/${digits.startsWith("0") ? `94${digits.slice(1)}` : digits}`;
  };
  const healthy = health.queue_failed === 0 && health.stale_in_flight === 0;
  return (
    <Card className={healthy ? "p-5" : "!border-gold bg-gold/5 p-5"}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-extrabold text-ink">📡 Tracking health</h2>
          <p className="font-display text-xs font-bold text-ink-soft">
            Webhooks, WhatsApp delivery queue, and parcels needing intervention
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 font-display text-xs font-extrabold ${healthy ? "bg-pond text-frog-dark" : "bg-gold/25 text-gold-dark"}`}>
          {healthy ? "● Healthy" : "● Attention needed"}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <HealthStat label="Last webhook" value={health.last_webhook_at ? timeAgo(health.last_webhook_at) : "Never"} />
        <HealthStat label="Last WhatsApp" value={health.last_notification_at ? timeAgo(health.last_notification_at) : "Never"} />
        <HealthStat label="Queued" value={String(health.queue_pending)} />
        <HealthStat label="Failed" value={String(health.queue_failed)} warn={health.queue_failed > 0} />
        <HealthStat label="Stale 24h+" value={String(health.stale_in_flight)} warn={health.stale_in_flight > 0} />
      </div>
      {health.problems.length > 0 && (
        <div className="mt-4 border-t-2 border-cardline/60 pt-3">
          <h3 className="mb-2 font-display text-xs font-extrabold uppercase tracking-wide text-flame-dark">
            ⚠️ Active delivery problems
          </h3>
          <div className="space-y-2">
            {health.problems.map((problem) => (
              <div key={problem.order_id} className="flex flex-wrap items-center gap-3 rounded-xl bg-white p-3">
                <div className="min-w-0 flex-1">
                  <div className="font-display text-sm font-extrabold text-ink">
                    {problem.order_no ?? problem.tracking_id} · {problem.customer_name}
                  </div>
                  <div className="font-display text-xs font-bold text-ink-soft">
                    {problem.status.replaceAll("_", " ")}
                    {problem.attempt ? ` · attempt ${problem.attempt}` : ""}
                    {` · ${timeAgo(problem.occurred_at)}`}
                  </div>
                  <div className="truncate font-display text-[11px] font-semibold text-ink-soft">{problem.checkpoint}</div>
                </div>
                <span className={`rounded-full px-2 py-1 font-display text-[10px] font-extrabold ${problem.notification_status === "sent" ? "bg-pond text-frog-dark" : problem.notification_status === "failed" ? "bg-flame-tint text-flame-dark" : "bg-gold/20 text-gold-dark"}`}>
                  WhatsApp {problem.notification_status ?? "not queued"}
                </span>
                <a href={phoneLink(problem.phone_number)} target="_blank" rel="noreferrer" className="rounded-xl bg-frog px-3 py-1.5 font-display text-xs font-extrabold text-white">
                  Contact customer
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function HealthStat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`rounded-xl p-3 ${warn ? "bg-flame-tint" : "bg-cream/70"}`}>
      <div className="font-display text-[10px] font-extrabold uppercase tracking-wide text-ink-soft">{label}</div>
      <div className={`mt-1 font-display text-sm font-extrabold ${warn ? "text-flame-dark" : "text-ink"}`}>{value}</div>
    </div>
  );
}

function Timeline({
  events,
  manifest,
}: {
  events: TrackingEvent[];
  manifest?: ShippingManifest;
}) {
  // Orders booked before this feature have no events — fall back to the
  // manifest's single last checkpoint so there's always something to show.
  const items: TrackingEvent[] =
    events.length > 0
      ? events
      : manifest
        ? [
            {
              id: manifest.id,
              order_id: manifest.order_id,
              checkpoint: manifest.last_checkpoint || "Booked with courier",
              outcome: "booked",
              created_at: manifest.created_at,
            },
          ]
        : [];

  if (items.length === 0) {
    return (
      <p className="font-display text-sm font-bold text-ink-soft">No tracking updates yet.</p>
    );
  }

  return (
    <ol className="relative ml-2 border-l-2 border-cardline">
      {items.map((ev, i) => {
        const style = OUTCOME_STYLE[ev.outcome] ?? OUTCOME_STYLE.in_transit;
        const isLast = i === items.length - 1;
        return (
          <li key={ev.id} className="relative mb-4 pl-5 last:mb-0">
            <span
              className={`absolute -left-[7px] top-1 h-3 w-3 rounded-full ${style.dot} ring-2 ring-white`}
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-display text-sm font-extrabold text-ink">
                {style.emoji} {style.label}
              </span>
              {isLast && (
                <span className="rounded-full bg-pond px-2 py-0.5 font-display text-[10px] font-extrabold text-frog-dark">
                  LATEST
                </span>
              )}
            </div>
            <p className="font-display text-xs font-semibold text-ink-soft">{ev.checkpoint}</p>
            <p className="font-display text-[11px] font-bold text-ink-soft">
              {fmtDateTime(ev.created_at)}
            </p>
          </li>
        );
      })}
    </ol>
  );
}

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Per-order panel showing whether each tracking alert reached the customer, with
// a manual (re)send button. A kind is shown when it fits the current status or
// has any send history, so the operator never sees "send delivered" pre-delivery.
function AlertsPanel({
  order,
  alerts,
  busyKey,
  onSend,
}: {
  order: Order;
  alerts: CustomerAlert[];
  busyKey: string | null;
  onSend: (order: Order, kind: AlertKind, alreadySent: boolean) => void;
}) {
  const kinds = (Object.keys(ALERT_LABELS) as AlertKind[]).filter(
    (k) => ALERT_FOR_STATUS[k] === order.order_status || alerts.some((a) => a.kind === k)
  );
  if (kinds.length === 0) return null;
  return (
    <div className="mt-4 border-t-2 border-cardline/60 pt-3">
      <h4 className="mb-2 font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">
        Customer alerts
      </h4>
      <div className="space-y-2">
        {kinds.map((kind) => {
          const forKind = alerts
            .filter((a) => a.kind === kind)
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
          const sent = forKind.find((a) => a.status === "sent");
          const latest = forKind[0];
          const busy = busyKey === `${order.id}:${kind}`;
          return (
            <div key={kind} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-display text-sm font-bold text-ink">{ALERT_LABELS[kind]}</div>
                <div className="font-display text-[11px] font-bold">
                  {sent ? (
                    <span className="text-frog-dark">✅ Sent {timeAgo(sent.created_at)}</span>
                  ) : latest?.status === "failed" ? (
                    <span className="text-flame-dark">⚠️ Send failed {timeAgo(latest.created_at)}</span>
                  ) : (
                    <span className="text-ink-soft">⚪ Not sent yet</span>
                  )}
                </div>
              </div>
              <Button
                tone={sent ? "ghost" : "frog"}
                onClick={() => onSend(order, kind, Boolean(sent))}
                disabled={busy}
                className="!px-3 !py-1.5 !text-xs"
              >
                {busy
                  ? "Sending…"
                  : sent
                    ? "Resend"
                    : latest?.status === "failed"
                      ? "Retry"
                      : "Send now"}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
