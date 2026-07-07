"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { phoneToChatId } from "@/lib/phone";
import { customerRisk } from "@/lib/risk";
import type { Order } from "@/lib/types";
import { Froggy } from "../components/froggy";
import { Button, Card, ProgressBar } from "../components/ui";

// Rate-limited WhatsApp broadcast to past customers (new-product launches,
// restock announcements). WhatsApp bans accounts that blast — so sends go out
// one at a time with a long random gap, capped per run, and only to people who
// have ordered before (an existing conversation = far lower ban risk).

const MAX_PER_RUN = 50;
const MIN_GAP_MS = 8_000;
const MAX_GAP_MS = 15_000;

type Audience = "delivered" | "all";

interface Recipient {
  phone: string;
  name: string;
  delivered: number;
  returned: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function BroadcastPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [audience, setAudience] = useState<Audience>("delivered");
  const [skipRisky, setSkipRisky] = useState(true);
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ sent: 0, failed: 0, total: 0, current: "" });
  const [done, setDone] = useState<string | null>(null);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/orders");
    const data = await res.json();
    if (res.ok) setOrders(data.orders);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // One entry per unique customer (newest name wins — orders are newest-first).
  const recipients = useMemo<Recipient[]>(() => {
    const seen = new Map<string, Recipient>();
    for (const o of orders) {
      const key = o.phone_number.replace(/\D/g, "").slice(-9);
      if (key.length < 9 || seen.has(key)) continue;
      const risk = customerRisk(orders, o.phone_number);
      if (audience === "delivered" && risk.delivered === 0) continue;
      if (skipRisky && risk.tier === "risky") continue;
      seen.set(key, {
        phone: o.phone_number,
        name: o.customer_name,
        delivered: risk.delivered,
        returned: risk.returned,
      });
    }
    return [...seen.values()];
  }, [orders, audience, skipRisky]);

  const batch = recipients.slice(0, MAX_PER_RUN);

  async function start() {
    if (!message.trim() || batch.length === 0 || running) return;
    if (
      !confirm(
        `Send this message to ${batch.length} customer${batch.length === 1 ? "" : "s"}?\n\n` +
          `It goes out one at a time over ~${Math.round((batch.length * 11.5) / 60)} min — keep this tab open.`
      )
    )
      return;

    setRunning(true);
    setDone(null);
    stopRef.current = false;
    let sent = 0;
    let failed = 0;
    setProgress({ sent: 0, failed: 0, total: batch.length, current: "" });

    for (const r of batch) {
      if (stopRef.current) break;
      setProgress({ sent, failed, total: batch.length, current: r.name });
      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: phoneToChatId(r.phone), text: message }),
        });
        if (res.ok) sent++;
        else failed++;
      } catch {
        failed++;
      }
      setProgress({ sent, failed, total: batch.length, current: r.name });
      if (r !== batch[batch.length - 1] && !stopRef.current) {
        await sleep(MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS));
      }
    }

    setRunning(false);
    setDone(
      stopRef.current
        ? `⏹️ Stopped — ${sent} sent, ${failed} failed before the stop.`
        : `✅ Broadcast finished — ${sent} sent${failed ? `, ${failed} failed` : ""}.`
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-5 p-5 sm:p-6">
      <header className="flex items-center gap-3">
        <Froggy mood={running ? "thinking" : "happy"} size={56} />
        <div>
          <h1 className="font-display text-2xl font-extrabold text-ink">Broadcast</h1>
          <p className="font-display text-sm font-bold text-ink-soft">
            Announce a launch or restock to customers who ordered before
          </p>
        </div>
      </header>

      <Card className="!border-gold bg-gold/10 p-4">
        <p className="font-display text-xs font-bold text-ink">
          ⚠️ WhatsApp bans numbers that spam. Sends are spaced 8–15 s apart,
          {` capped at ${MAX_PER_RUN} per run, `}and should go to past customers only. Keep
          messages personal, don&apos;t run this daily, and stop if customers report you.
        </p>
      </Card>

      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-4">
          <label className="font-display text-xs font-bold text-ink-soft">
            Audience
            <select
              className="mt-1 block rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2 font-display text-sm font-bold text-ink outline-none focus:border-frog"
              value={audience}
              onChange={(e) => setAudience(e.target.value as Audience)}
              disabled={running}
            >
              <option value="delivered">Delivered customers (recommended)</option>
              <option value="all">Everyone who ever ordered</option>
            </select>
          </label>
          <label className="flex items-center gap-2 pt-4 font-display text-sm font-bold text-ink-soft">
            <input
              type="checkbox"
              checked={skipRisky}
              onChange={(e) => setSkipRisky(e.target.checked)}
              disabled={running}
              className="h-4 w-4 accent-[var(--color-frog)]"
            />
            Skip risky customers (more returns than deliveries)
          </label>
        </div>

        <p className="font-display text-sm font-extrabold text-ink">
          🎯 {recipients.length} recipient{recipients.length === 1 ? "" : "s"}
          {recipients.length > MAX_PER_RUN && (
            <span className="text-ink-soft"> — first {MAX_PER_RUN} this run</span>
          )}
        </p>

        <label className="block font-display text-xs font-bold text-ink-soft">
          Message
          <textarea
            rows={6}
            className="mt-1 w-full rounded-xl border-2 border-cardline bg-cream/60 p-3 text-sm font-semibold text-ink outline-none focus:border-frog"
            placeholder={"අලුත් stock ආවා! 🎉 …"}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={running}
          />
        </label>

        {running ? (
          <div className="space-y-2">
            <ProgressBar
              value={((progress.sent + progress.failed) / Math.max(progress.total, 1)) * 100}
              tone="var(--color-frog)"
            />
            <div className="flex items-center justify-between">
              <p className="font-display text-sm font-bold text-ink">
                📨 {progress.sent + progress.failed}/{progress.total} — sending to{" "}
                {progress.current}…
              </p>
              <Button tone="ghost" onClick={() => (stopRef.current = true)}>
                ⏹️ Stop
              </Button>
            </div>
            <p className="font-display text-xs font-bold text-ink-soft">
              Keep this tab open — closes cancel the rest of the run.
            </p>
          </div>
        ) : (
          <Button
            tone="frog"
            onClick={start}
            disabled={!message.trim() || batch.length === 0}
            className="!py-3"
          >
            📣 Send to {batch.length} customer{batch.length === 1 ? "" : "s"}
          </Button>
        )}

        {done && (
          <p className="animate-pop rounded-xl border-2 border-frog bg-pond p-2.5 font-display text-xs font-bold text-frog-dark">
            {done}
          </p>
        )}
      </Card>

      {recipients.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-2 font-display text-sm font-extrabold uppercase tracking-wide text-ink-soft">
            Recipients
          </h2>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {batch.map((r) => (
              <p key={r.phone} className="font-display text-sm font-bold text-ink">
                {r.name}{" "}
                <span className="text-ink-soft">
                  · {r.phone} · ✅{r.delivered}
                  {r.returned > 0 ? ` ↩️${r.returned}` : ""}
                </span>
              </p>
            ))}
          </div>
        </Card>
      )}
    </main>
  );
}
