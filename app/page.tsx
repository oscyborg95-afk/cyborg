"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { DISTRICTS, shippingFeeFor } from "@/lib/districts";
import { chatIdToPhone } from "@/lib/phone";
import { templates } from "@/lib/templates";
import type {
  ChatState,
  ChatStateValue,
  Order,
  Product,
  ShippingManifest,
  WaChat,
  WaMessage,
} from "@/lib/types";
import { Froggy, type FroggyMood } from "./components/froggy";
import { Button, Card, Confetti } from "./components/ui";

const WORKER_URL = process.env.NEXT_PUBLIC_WA_WORKER_URL || "http://localhost:3001";

const FILTERS = ["All", "Unreplied", "Awaiting Address", "Shipped"] as const;
type Filter = (typeof FILTERS)[number];

const STATE_BADGES: Record<ChatStateValue, { label: string; className: string }> = {
  NEW: { label: "NEW", className: "bg-[#f2ede3] text-ink-soft" },
  AWAITING_ADDRESS: { label: "AWAIT ADDR", className: "bg-flame-tint text-flame-dark" },
  AWAITING_CONFIRMATION: { label: "AWAIT CONF", className: "bg-gold/25 text-gold-dark" },
  CONFIRMED: { label: "CONFIRMED", className: "bg-sky-tint text-sky-dark" },
  SHIPPED: { label: "SHIPPED", className: "bg-pond text-frog-dark" },
};

interface Draft {
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

const inputCls =
  "mt-1 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2 font-display text-sm font-bold text-ink outline-none focus:border-frog";

export default function Workspace() {
  const [chats, setChats] = useState<WaChat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WaMessage[]>([]);
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState<Filter>("All");
  const [states, setStates] = useState<Record<string, ChatState>>({});
  const [orders, setOrders] = useState<Order[]>([]);
  const [manifests, setManifests] = useState<ShippingManifest[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [workerOffline, setWorkerOffline] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [parsing, setParsing] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  // Confirmation message drafted after a successful dispatch — sent manually.
  const [confirmText, setConfirmText] = useState<string | null>(null);
  const [sendingConfirm, setSendingConfirm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const [waReady, setWaReady] = useState<boolean | null>(null); // null = not known yet
  const [qrImage, setQrImage] = useState<string | null>(null);

  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const prevWaReadyRef = useRef<boolean | null>(null);

  const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
  const activePhone = activeChatId ? chatIdToPhone(activeChatId) : null;
  const activeState: ChatStateValue = (activePhone && states[activePhone]?.state) || "NEW";
  const activeOrders = orders.filter((o) => o.phone_number === activePhone);
  const latestManifest = manifests
    .filter((m) => activeOrders.some((o) => o.id === m.order_id))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

  const loadChats = useCallback(async () => {
    const res = await fetch("/api/whatsapp/chats");
    const data = await res.json();
    if (res.ok) {
      setChats(data.chats);
      setWorkerOffline(false);
    } else if (data.offline) {
      setWorkerOffline(true);
    }
  }, []);

  const loadStates = useCallback(async () => {
    const res = await fetch("/api/chat-state");
    const data = await res.json();
    if (res.ok) {
      const map: Record<string, ChatState> = {};
      for (const s of data.states as ChatState[]) map[s.phone_number] = s;
      setStates(map);
    }
  }, []);

  const loadOrders = useCallback(async () => {
    const res = await fetch("/api/orders");
    const data = await res.json();
    if (res.ok) {
      setOrders(data.orders);
      setManifests(data.manifests);
    }
  }, []);

  const loadMessages = useCallback(async (chatId: string) => {
    const res = await fetch(`/api/whatsapp/messages/${encodeURIComponent(chatId)}`);
    const data = await res.json();
    if (res.ok) setMessages(data.messages);
  }, []);

  const loadProducts = useCallback(async () => {
    const res = await fetch("/api/products");
    const data = await res.json();
    if (res.ok) setProducts(data.products);
  }, []);

  // Straight to the worker (not proxied through Next) — same-origin CORS is
  // already open on it, and it's the only place that knows the live QR.
  const loadWaStatus = useCallback(async () => {
    try {
      const res = await fetch(`${WORKER_URL}/qr.json`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setWaReady(data.ready);
      setQrImage(data.qr);
    } catch {
      // Worker unreachable — the "offline" banner (driven by /api/whatsapp/chats) covers this.
    }
  }, []);

  // Initial load + realtime socket.
  useEffect(() => {
    loadChats();
    loadStates();
    loadOrders();
    loadProducts();
    loadWaStatus();

    const socket: Socket = io(WORKER_URL, { transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      setWorkerOffline(false);
      loadWaStatus();
    });
    socket.on("wa:status", ({ ready: r }: { ready: boolean }) => setWaReady(r));
    socket.on("wa:qr", ({ qr }: { qr: string }) => setQrImage(qr));
    socket.on("wa:message", (msg: WaMessage) => {
      if (msg.chatId === activeChatIdRef.current) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.id)) return prev;
          // Our own sends are shown optimistically with a local- id; swap the
          // placeholder for the real message when the worker echoes it back.
          const tempIdx = msg.fromMe
            ? prev.findIndex((m) => m.id.startsWith("local-") && m.body === msg.body)
            : -1;
          const base = tempIdx === -1 ? prev : prev.filter((_, i) => i !== tempIdx);
          return [...base, msg];
        });
      }
      setChats((prev) => {
        const existing = prev.find((c) => c.id === msg.chatId);
        const updated: WaChat = existing
          ? {
              ...existing,
              lastMessage: msg.body,
              timestamp: msg.timestamp,
              unreadCount:
                msg.fromMe || msg.chatId === activeChatIdRef.current
                  ? 0
                  : existing.unreadCount + 1,
            }
          : {
              id: msg.chatId,
              name: msg.senderName || chatIdToPhone(msg.chatId),
              lastMessage: msg.body,
              timestamp: msg.timestamp,
              unreadCount: msg.fromMe ? 0 : 1,
            };
        return [updated, ...prev.filter((c) => c.id !== msg.chatId)].sort(
          (a, b) => b.timestamp - a.timestamp
        );
      });
    });
    return () => {
      socket.disconnect();
    };
  }, [loadChats, loadStates, loadOrders, loadProducts, loadWaStatus]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // A little celebration the moment WhatsApp goes from "scan me" to linked.
  useEffect(() => {
    if (prevWaReadyRef.current === false && waReady === true) {
      setCelebrate(true);
      setTimeout(() => setCelebrate(false), 3600);
    }
    prevWaReadyRef.current = waReady;
  }, [waReady]);

  async function selectChat(chatId: string) {
    setActiveChatId(chatId);
    setDraft(null);
    setConfirmText(null);
    setNotice(null);
    setError(null);
    setChats((prev) => prev.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c)));
    await loadMessages(chatId);
  }

  async function setChatState(state: ChatStateValue) {
    if (!activeChatId || !activePhone) return;
    const res = await fetch("/api/chat-state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phone_number: activePhone,
        chat_id: activeChatId,
        state,
        display_name: activeChat?.name,
      }),
    });
    const data = await res.json();
    if (res.ok) setStates((prev) => ({ ...prev, [activePhone]: data.state }));
  }

  async function sendText(text: string): Promise<boolean> {
    if (!activeChatId || !text.trim()) return false;
    setError(null);
    // Optimistic: show the bubble immediately; the worker's socket echo
    // replaces it with the real message (no full-list reload round trip).
    const temp: WaMessage = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chatId: activeChatId,
      body: text,
      fromMe: true,
      timestamp: Date.now(),
      senderName: "You",
    };
    setMessages((prev) => [...prev, temp]);
    const res = await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: activeChatId, text }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessages((prev) => prev.filter((m) => m.id !== temp.id));
      setError(data.error);
      if (data.offline) setWorkerOffline(true);
      return false;
    }
    return true;
  }

  async function handleSend() {
    const text = input;
    setInput("");
    const ok = await sendText(text);
    if (!ok) setInput(text); // give the typed message back on failure
  }

  // --- Quick actions (dynamic action bar) ---------------------------------

  const draftTotal = draft
    ? Math.max(
        0,
        Number(draft.product_price || 0) +
          Number(draft.shipping_fee || 0) -
          Number(draft.discount || 0)
      )
    : 0;

  async function quickAskAddress() {
    await sendText(templates.askAddress());
    await setChatState("AWAITING_ADDRESS");
  }

  async function quickCodConfirm() {
    await sendText(templates.codConfirm(draftTotal));
    await setChatState("AWAITING_CONFIRMATION");
  }

  async function quickTrackingAlert() {
    if (!latestManifest) return;
    await sendText(templates.trackingAlert(latestManifest.tracking_id));
  }

  async function quickDelayBonus() {
    await sendText(templates.delayBonus());
  }

  // --- Logistics copilot (right panel) -------------------------------------

  async function parseFromChat() {
    if (!activeChatId) return;
    setParsing(true);
    setError(null);
    try {
      const customerLines = messages
        .filter((m) => !m.fromMe)
        .slice(-12)
        .map((m) => m.body)
        .join("\n");
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_text: customerLines }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDraft({
        customer_name: data.name,
        phone_number: data.phone || (activePhone ?? ""),
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
      await setChatState("CONFIRMED");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Parsing failed");
    } finally {
      setParsing(false);
    }
  }

  async function dispatch() {
    if (!draft || !activeChatId) return;
    setDispatching(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: activeChatId,
          ...draft,
          raw_address: messages.filter((m) => !m.fromMe).slice(-12).map((m) => m.body).join("\n"),
          product_price: Number(draft.product_price || 0),
          shipping_fee: Number(draft.shipping_fee || 0),
          discount: Number(draft.discount || 0),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.manifest?.pdf_label_url) window.open(data.manifest.pdf_label_url, "_blank");
      setNotice(`Booked ✓ ${data.manifest.tracking_id}`);
      // Draft the customer confirmation but let the operator send it manually.
      setConfirmText(
        templates.shippedConfirmation(data.order.total_cod, data.manifest.tracking_id)
      );
      setCelebrate(true);
      setTimeout(() => setCelebrate(false), 3600);
      setDraft(null);
      await Promise.all([loadOrders(), loadStates(), loadMessages(activeChatId), loadProducts()]);
      // Update the nav chips + tell the operator where today's quest stands.
      window.dispatchEvent(new Event("metrics:refresh"));
      try {
        const m = (await (await fetch("/api/metrics")).json()).metrics;
        if (m) {
          setNotice(
            `Booked ✓ ${data.manifest.tracking_id}` +
              (m.shippedToday >= m.dailyGoal
                ? ` — 🎯 DAILY GOAL COMPLETE (${m.shippedToday}/${m.dailyGoal})!`
                : ` — 📦 ${m.shippedToday}/${m.dailyGoal} today, ${m.dailyGoal - m.shippedToday} to go!`)
          );
        }
      } catch {
        // metrics are decoration — the booking already succeeded
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dispatch failed");
    } finally {
      setDispatching(false);
    }
  }

  async function sendConfirmation() {
    if (!confirmText) return;
    setSendingConfirm(true);
    try {
      const ok = await sendText(confirmText);
      if (ok) {
        setConfirmText(null);
        setNotice((prev) => (prev ? `${prev} — confirmation sent` : "Confirmation sent ✓"));
      }
    } finally {
      setSendingConfirm(false);
    }
  }

  const setDraftField = (field: keyof Draft, value: string) => {
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d, [field]: value };
      if (field === "district") next.shipping_fee = String(shippingFeeFor(value));
      return next;
    });
  };

  // --- Filters --------------------------------------------------------------

  const visibleChats = chats.filter((c) => {
    const state = states[chatIdToPhone(c.id)]?.state;
    if (filter === "Unreplied") return c.unreadCount > 0;
    if (filter === "Awaiting Address") return state === "AWAITING_ADDRESS";
    if (filter === "Shipped") return state === "SHIPPED";
    return true;
  });

  const copilotMood: FroggyMood = celebrate
    ? "celebrate"
    : parsing
      ? "thinking"
      : draft
        ? "happy"
        : activeChat
          ? "idle"
          : "sleepy";

  // Nothing to work with until WhatsApp is actually linked — take over the
  // screen with the QR instead of showing an empty inbox.
  if (!workerOffline && waReady === false) {
    return (
      <>
        <Confetti run={celebrate} />
        <LinkWhatsAppScreen qrImage={qrImage} />
      </>
    );
  }

  return (
    <div className="grid h-full grid-cols-[290px_1fr_350px] divide-x-2 divide-cardline">
      <Confetti run={celebrate} />

      {/* LEFT: inbox */}
      <aside className="flex min-h-0 flex-col bg-white/50">
        <div className="flex flex-wrap gap-1 border-b-2 border-cardline p-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={
                "rounded-full px-2.5 py-1 font-display text-xs font-bold transition " +
                (filter === f
                  ? "bg-frog text-white"
                  : "bg-[#f2ede3] text-ink-soft hover:bg-pond hover:text-frog-dark")
              }
            >
              {f}
            </button>
          ))}
        </div>
        {workerOffline && (
          <div className="border-b-2 border-cardline bg-flame-tint p-3 font-display text-xs font-bold text-flame-dark">
            📵 WhatsApp worker offline. Start it:
            <code className="mt-1 block rounded-lg bg-white px-2 py-1 font-mono text-ink">
              cd worker && npm start
            </code>
            (or <code>npm run mock</code> for fake chats)
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {visibleChats.map((chat) => {
            const state = states[chatIdToPhone(chat.id)]?.state ?? "NEW";
            const badge = STATE_BADGES[state];
            return (
              <button
                key={chat.id}
                onClick={() => selectChat(chat.id)}
                className={
                  "block w-full border-b border-cardline/60 px-3 py-2.5 text-left transition hover:bg-pond/40 " +
                  (chat.id === activeChatId ? "bg-pond/70" : "")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-display text-sm font-bold text-ink">
                    {chat.unreadCount > 0 && (
                      <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-frog align-middle" />
                    )}
                    {chat.name}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 font-display text-[10px] font-extrabold ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </div>
                <p className="mt-0.5 truncate text-xs font-semibold text-ink-soft">
                  {chat.lastMessage}
                </p>
              </button>
            );
          })}
          {visibleChats.length === 0 && (
            <div className="flex flex-col items-center gap-2 p-6 text-center">
              <Froggy mood="sleepy" size={64} />
              <p className="font-display text-xs font-bold text-ink-soft">
                No chats in this view.
              </p>
            </div>
          )}
        </div>
      </aside>

      {/* CENTER: live chat + action bar */}
      <section className="flex min-h-0 flex-col">
        {activeChat ? (
          <>
            <div className="flex items-center gap-3 border-b-2 border-cardline bg-white/60 px-4 py-2">
              <div>
                <div className="font-display text-base font-extrabold text-ink">
                  {activeChat.name}
                </div>
                <div className="text-xs font-semibold text-ink-soft">{activePhone}</div>
              </div>
              <select
                className="ml-auto rounded-xl border-2 border-cardline bg-white px-2 py-1.5 font-display text-xs font-bold text-ink outline-none focus:border-frog"
                value={activeState}
                onChange={(e) => setChatState(e.target.value as ChatStateValue)}
              >
                {Object.keys(STATE_BADGES).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
              {messages.map((m) => (
                <div key={m.id} className={m.fromMe ? "flex justify-end" : "flex justify-start"}>
                  <div
                    className={
                      "max-w-[70%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm font-semibold shadow-sm " +
                      (m.fromMe
                        ? "rounded-br-md bg-frog text-white"
                        : "rounded-bl-md border-2 border-cardline bg-white text-ink")
                    }
                  >
                    {m.body}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>

            {/* Dynamic action bar */}
            <div className="flex flex-wrap gap-2 border-t-2 border-cardline bg-white/60 px-4 py-2.5">
              <Button tone="ghost" onClick={quickAskAddress} className="!px-3 !py-2 !text-xs">
                📍 Ask for address
              </Button>
              {draftTotal > 0 && (
                <Button tone="gold" onClick={quickCodConfirm} className="!px-3 !py-2 !text-xs">
                  💰 Send Rs. {draftTotal} COD confirm
                </Button>
              )}
              {activeState === "SHIPPED" && latestManifest && (
                <Button tone="sky" onClick={quickTrackingAlert} className="!px-3 !py-2 !text-xs">
                  📦 Send tracking alert
                </Button>
              )}
              <Button tone="ghost" onClick={quickDelayBonus} className="!px-3 !py-2 !text-xs">
                🎁 Shipping delay bonus
              </Button>
            </div>

            <div className="flex gap-2 border-t-2 border-cardline bg-white/60 p-3">
              <input
                className="flex-1 rounded-xl border-2 border-cardline bg-white px-3.5 py-2.5 text-sm font-semibold text-ink outline-none focus:border-frog"
                placeholder="Type a message…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
              />
              <Button tone="frog" onClick={handleSend} disabled={!input.trim()}>
                Send
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <Froggy mood="idle" size={110} />
            <p className="font-display text-base font-bold text-ink-soft">
              Pick a chat and let&apos;s ship some orders!
            </p>
          </div>
        )}
      </section>

      {/* RIGHT: logistics copilot */}
      <aside className="flex min-h-0 flex-col overflow-y-auto bg-white/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Froggy mood={copilotMood} size={44} bob={false} />
          <h2 className="font-display text-sm font-extrabold uppercase tracking-wide text-ink-soft">
            Dispatch copilot
          </h2>
        </div>

        {error && (
          <p className="mb-3 rounded-xl border-2 border-[#f3c1c1] bg-[#fdecec] p-2.5 font-display text-xs font-bold text-[#c04545]">
            {error}
          </p>
        )}
        {notice && (
          <p className="mb-3 animate-pop rounded-xl border-2 border-frog bg-pond p-2.5 font-display text-xs font-bold text-frog-dark">
            🎉 {notice}{" "}
            <a href="/invoices" className="underline">
              Print invoice →
            </a>
          </p>
        )}
        {confirmText && (
          <div className="mb-3 animate-pop rounded-xl border-2 border-gold bg-gold/15 p-2.5">
            <p className="mb-1.5 font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">
              📨 Confirmation ready — not sent yet
            </p>
            <p className="mb-2 whitespace-pre-wrap rounded-lg bg-white/70 p-2 text-xs font-semibold text-ink">
              {confirmText}
            </p>
            <div className="flex gap-2">
              <Button
                tone="frog"
                onClick={sendConfirmation}
                disabled={sendingConfirm}
                className="!px-3 !py-2 !text-xs"
              >
                {sendingConfirm ? "Sending…" : "Send to customer"}
              </Button>
              <Button
                tone="ghost"
                onClick={() => setConfirmText(null)}
                disabled={sendingConfirm}
                className="!px-3 !py-2 !text-xs"
              >
                Don&apos;t send
              </Button>
            </div>
          </div>
        )}

        {activeChat ? (
          <>
            <Button
              tone="grape"
              onClick={parseFromChat}
              disabled={parsing || messages.length === 0}
              className="mb-4 w-full"
            >
              {parsing ? "🤔 Reading the chat…" : "🪄 Parse address from chat"}
            </Button>

            {draft && (
              <div className="animate-pop space-y-2.5">
                {(
                  [
                    ["customer_name", "Name"],
                    ["phone_number", "Phone"],
                    ["phone_2", "Phone 2 (optional)"],
                    ["parsed_address", "Address"],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field} className="block font-display text-xs font-bold text-ink-soft">
                    {label}
                    <input
                      className={inputCls}
                      value={draft[field]}
                      onChange={(e) => setDraftField(field, e.target.value)}
                    />
                  </label>
                ))}
                <div className="grid grid-cols-2 gap-2">
                  <label className="block font-display text-xs font-bold text-ink-soft">
                    City / Town
                    <input
                      className={inputCls}
                      value={draft.city}
                      onChange={(e) => setDraftField("city", e.target.value)}
                      placeholder="e.g. Nugegoda"
                    />
                  </label>
                  <label className="block font-display text-xs font-bold text-ink-soft">
                    District
                    <select
                      className={inputCls}
                      value={draft.district}
                      onChange={(e) => setDraftField("district", e.target.value)}
                    >
                      {DISTRICTS.map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {products.length > 0 && (
                  <div>
                    <p className="mb-1 font-display text-xs font-bold text-ink-soft">
                      Product <span className="font-normal">(tap to fill)</span>
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {products.map((p) => {
                        const active = draft.product_id === p.id;
                        const out = p.stock_units <= 0;
                        return (
                          <button
                            key={p.id}
                            onClick={() =>
                              setDraft((d) =>
                                d
                                  ? {
                                      ...d,
                                      product_id: p.id,
                                      item_name: p.name,
                                      product_price: String(p.price),
                                    }
                                  : d
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
                <label className="block font-display text-xs font-bold text-ink-soft">
                  Item name <span className="font-normal">(prints on the invoice)</span>
                  <input
                    className={inputCls}
                    value={draft.item_name}
                    onChange={(e) =>
                      setDraft((d) =>
                        d ? { ...d, item_name: e.target.value, product_id: "" } : d
                      )
                    }
                    placeholder="e.g. Posture corrector"
                  />
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <label className="block font-display text-xs font-bold text-ink-soft">
                    Price (Rs.)
                    <input
                      type="number"
                      className={inputCls}
                      value={draft.product_price}
                      onChange={(e) => setDraftField("product_price", e.target.value)}
                    />
                  </label>
                  <label className="block font-display text-xs font-bold text-ink-soft">
                    Ship (Rs.)
                    <input
                      type="number"
                      className={inputCls}
                      value={draft.shipping_fee}
                      onChange={(e) => setDraftField("shipping_fee", e.target.value)}
                    />
                  </label>
                  <label className="block font-display text-xs font-bold text-ink-soft">
                    Disc. (Rs.)
                    <input
                      type="number"
                      className={inputCls}
                      value={draft.discount}
                      onChange={(e) => setDraftField("discount", e.target.value)}
                    />
                  </label>
                </div>
                <div className="rounded-xl bg-gold/15 px-3 py-2 font-display text-sm font-extrabold text-ink">
                  Total COD: Rs. {draftTotal}
                </div>
                <Button
                  tone="frog"
                  onClick={dispatch}
                  disabled={dispatching || draftTotal <= 0}
                  className="w-full !py-3"
                >
                  {dispatching ? "🚀 Dispatching…" : "🚀 DISPATCH — book & message"}
                </Button>
                <p className="text-[11px] font-semibold leading-snug text-ink-soft">
                  Books the courier, saves the tracking ID, and marks this chat SHIPPED.
                  The Sinhala confirmation is drafted for you to review &amp; send.
                </p>
              </div>
            )}

            {/* Shipment history for this customer */}
            {activeOrders.length > 0 && (
              <div className="mt-6">
                <h3 className="mb-2 font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">
                  Shipments for this customer
                </h3>
                {activeOrders.map((o) => {
                  const m = manifests.find((mm) => mm.order_id === o.id);
                  return (
                    <div
                      key={o.id}
                      className="card3d mb-2 p-2.5 font-display text-xs font-bold"
                    >
                      <div className="flex justify-between">
                        <span className="text-ink">Rs. {o.total_cod}</span>
                        <span className="text-ink-soft">{o.order_status}</span>
                      </div>
                      {m && <div className="mt-1 font-mono text-ink-soft">{m.tracking_id}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <p className="font-display text-xs font-bold text-ink-soft">
            Open a chat to see order tools.
          </p>
        )}
      </aside>
    </div>
  );
}

function LinkWhatsAppScreen({ qrImage }: { qrImage: string | null }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-6 text-center">
      <Froggy mood={qrImage ? "idle" : "thinking"} size={100} />
      <div>
        <h1 className="font-display text-2xl font-extrabold text-ink">
          {qrImage ? "📱 Scan to link WhatsApp" : "⏳ Starting up…"}
        </h1>
        <p className="mt-1 font-display text-sm font-bold text-ink-soft">
          {qrImage
            ? "WhatsApp → Settings → Linked Devices → Link a Device"
            : "Generating a QR code — this only takes a moment."}
        </p>
      </div>
      {qrImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- a live base64 data URI, not a static asset
        <Card className="p-4">
          <img
            src={qrImage}
            alt="Scan with WhatsApp to link this device"
            width={260}
            height={260}
            className="rounded-xl"
          />
        </Card>
      ) : (
        <Card className="flex h-[260px] w-[260px] items-center justify-center p-4">
          <span className="font-display text-sm font-bold text-ink-soft">Loading…</span>
        </Card>
      )}
      <p className="font-display text-xs font-bold text-ink-soft">
        This page updates itself automatically — no need to refresh. The QR rotates every ~20s
        until it&apos;s scanned.
      </p>
    </div>
  );
}
