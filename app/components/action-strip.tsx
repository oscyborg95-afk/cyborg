"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AttentionItem, AttentionStatus } from "@/lib/types";
import { money, timeAgo } from "./crm-ui";

type Feed = { items: AttentionItem[]; counts: Record<string, number>; cod_at_risk: number };

// The workspace stays open all day, so this refreshes on its own rather than
// waiting for someone to remember a separate page.
const REFRESH_MS = 90_000;

const PRIORITY = {
  urgent: { icon: "🔥", rail: "border-l-flame", text: "text-flame-dark" },
  high: { icon: "⚡", rail: "border-l-gold", text: "text-gold-dark" },
  medium: { icon: "●", rail: "border-l-sky", text: "text-sky-dark" },
  low: { icon: "●", rail: "border-l-cardline", text: "text-ink-soft" },
} as const;

const GOES_TO_ORDERS: ReadonlySet<AttentionItem["kind"]> = new Set([
  "order_ready",
  "delivery_problem",
]);

function copyFor(item: AttentionItem) {
  if (item.kind === "ai_handoff") return "This one was handed over for a human reply.";
  if (item.kind === "failed_message") return "A message could not be sent.";
  return item.summary;
}

export function ActionStrip({
  activeChatId,
  onOpenChat,
}: {
  activeChatId: string | null;
  onOpenChat: (chatId: string) => void;
}) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/attention", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "failed");
      setFeed(data);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (alive) void load();
    };
    // The first fetch goes through the same timer path as the refreshes so no
    // state is set synchronously while the workspace is still rendering.
    const first = setTimeout(tick, 0);
    const repeat = setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      clearTimeout(first);
      clearInterval(repeat);
    };
  }, [load]);

  // Only the things a person has to decide. Everything lower sits quietly in
  // the chat list where it already shows up as an unread.
  const items = useMemo(
    () => (feed?.items ?? []).filter((item) => item.priority === "urgent" || item.priority === "high"),
    [feed]
  );

  async function update(id: string, status: AttentionStatus) {
    setBusy(id);
    const body =
      status === "snoozed"
        ? { status, snoozed_until: new Date(Date.now() + 60 * 60 * 1000).toISOString() }
        : { status };
    try {
      const response = await fetch(`/api/attention/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("failed");
      setFeed((current) =>
        current ? { ...current, items: current.items.filter((item) => item.id !== id) } : current
      );
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  if (failed && !feed) return null;
  if (items.length === 0) return null;

  const urgent = items.filter((item) => item.priority === "urgent").length;
  // Summed from what is actually on screen, so clearing an item drops its money
  // out of the header instead of leaving a stale server total.
  const codAtRisk = items.reduce((sum, item) => {
    const value = Number(item.payload.total_cod);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

  return (
    <section
      aria-label="Actions needing a decision"
      className="border-b-2 border-cardline bg-white/70"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-xs font-extrabold text-ink transition hover:bg-pond/40"
      >
        <span aria-hidden="true">{urgent > 0 ? "🔥" : "⚡"}</span>
        <span className="flex-1">
          Needs you · {items.length}
          {codAtRisk > 0 && (
            <span className="ml-1 font-bold text-gold-dark">{money(codAtRisk)} COD</span>
          )}
        </span>
        <span className={`text-ink-soft transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <ul className="max-h-64 overflow-y-auto">
          {items.map((item) => {
            const style = PRIORITY[item.priority];
            const toOrders = GOES_TO_ORDERS.has(item.kind);
            const cod = Number(item.payload.total_cod);
            return (
              <li
                key={item.id}
                className={`border-l-4 border-b border-cardline/60 px-3 py-2 ${style.rail} ${
                  item.chat_id && item.chat_id === activeChatId ? "bg-pond/60" : ""
                }`}
              >
                {toOrders || !item.chat_id ? (
                  <Link
                    href={
                      toOrders
                        ? "/orders"
                        : `/customers/${encodeURIComponent(item.phone_key)}`
                    }
                    className="block text-left"
                  >
                    <ItemBody item={item} style={style} cod={cod} />
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpenChat(item.chat_id as string)}
                    className="block w-full text-left"
                  >
                    <ItemBody item={item} style={style} cod={cod} />
                  </button>
                )}
                <div className="mt-1.5 flex gap-1.5">
                  <button
                    type="button"
                    disabled={busy === item.id}
                    onClick={() => void update(item.id, "resolved")}
                    className="rounded-lg border border-frog bg-pond px-2 py-0.5 font-display text-[10px] font-extrabold text-frog-dark disabled:opacity-50"
                  >
                    Done
                  </button>
                  <button
                    type="button"
                    disabled={busy === item.id}
                    onClick={() => void update(item.id, "snoozed")}
                    className="rounded-lg border border-cardline bg-white px-2 py-0.5 font-display text-[10px] font-extrabold text-ink-soft disabled:opacity-50"
                  >
                    Snooze 1h
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ItemBody({
  item,
  style,
  cod,
}: {
  item: AttentionItem;
  style: (typeof PRIORITY)[keyof typeof PRIORITY];
  cod: number;
}) {
  return (
    <>
      <div className="flex items-baseline gap-1.5">
        <span className={`text-[10px] ${style.text}`} aria-hidden="true">
          {style.icon}
        </span>
        <span className="min-w-0 flex-1 truncate font-display text-xs font-extrabold text-ink">
          {item.customer?.display_name || item.title}
        </span>
        <span className="shrink-0 text-[10px] font-bold text-ink-soft">
          {timeAgo(item.due_at ?? item.created_at)}
        </span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-[11px] font-semibold text-ink-soft">{copyFor(item)}</p>
      {Number.isFinite(cod) && cod > 0 && (
        <span className="text-[10px] font-extrabold text-gold-dark">{money(cod)} COD</span>
      )}
    </>
  );
}
