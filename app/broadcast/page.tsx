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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ sent: 0, failed: 0, total: 0, current: "" });
  const [done, setDone] = useState<string | null>(null);
  const stopRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/orders");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load past customers");
      setOrders(data.orders);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load past customers");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
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
    <main className="mx-auto max-w-3xl space-y-5 p-4 pb-28 sm:p-6 sm:pb-6">
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

      {error && (
        <Card className="grid gap-3 !border-danger-line bg-danger-bg p-4 sm:flex sm:items-center sm:justify-between">
          <p role="alert" className="font-display text-sm font-bold text-danger-ink">⚠️ {error}</p>
          <button type="button" onClick={() => { setLoading(true); void load(); }} className="min-h-11 rounded-xl border-2 border-danger-line px-4 py-2 font-display text-sm font-extrabold text-danger-ink focus:outline-none focus:ring-2 focus:ring-danger-ink">Try again</button>
        </Card>
      )}

      <Card className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-4 sm:flex sm:flex-wrap sm:items-center">
          <label className="font-display text-xs font-bold text-ink-soft">
            Audience
            <select
              className="mt-1 block min-h-12 w-full max-w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2 font-display text-base font-bold text-ink outline-none focus:border-frog focus:ring-2 focus:ring-frog/20 sm:w-auto sm:text-sm"
              value={audience}
              onChange={(e) => setAudience(e.target.value as Audience)}
              disabled={running}
            >
              <option value="delivered">Delivered customers (recommended)</option>
              <option value="all">Everyone who ever ordered</option>
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-3 rounded-xl bg-surface-soft px-3 py-2 font-display text-sm font-bold text-ink-soft sm:mt-4">
            <input
              type="checkbox"
              checked={skipRisky}
              onChange={(e) => setSkipRisky(e.target.checked)}
              disabled={running}
              className="h-5 w-5 shrink-0 accent-[var(--color-frog)]"
            />
            Skip risky customers (more returns than deliveries)
          </label>
        </div>

        <p role="status" className="font-display text-sm font-extrabold text-ink">
          {loading ? "⏳ Finding eligible past customers…" : `🎯 ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`}
          {recipients.length > MAX_PER_RUN && (
            <span className="text-ink-soft"> — first {MAX_PER_RUN} this run</span>
          )}
        </p>

        <label className="block font-display text-xs font-bold text-ink-soft">
          Message
          <textarea
            rows={6}
            className="mt-1 min-h-40 w-full rounded-xl border-2 border-cardline bg-cream/60 p-3 text-base font-semibold text-ink outline-none focus:border-frog focus:ring-2 focus:ring-frog/20 sm:text-sm"
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
            <div className="grid gap-3 sm:flex sm:items-center sm:justify-between">
              <p className="font-display text-sm font-bold text-ink">
                📨 {progress.sent + progress.failed}/{progress.total} — sending to{" "}
                {progress.current}…
              </p>
              <Button className="w-full sm:w-auto" tone="ghost" onClick={() => (stopRef.current = true)}>
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
            disabled={loading || !message.trim() || batch.length === 0}
            className="min-h-12 w-full !py-3"
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
        <details className="card3d overflow-hidden">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 p-4 font-display text-sm font-extrabold uppercase tracking-wide text-ink-soft focus:outline-none focus:ring-2 focus:ring-inset focus:ring-frog sm:p-5">
            <span>Recipients · {batch.length}</span><span aria-hidden>▾</span>
          </summary>
          <div className="grid grid-cols-1 gap-2 border-t-2 border-cardline p-4 sm:grid-cols-2 sm:p-5">
            {batch.map((r) => (
              <p key={r.phone} className="break-words rounded-xl bg-surface-soft p-3 font-display text-sm font-bold text-ink">
                {r.name}{" "}
                <span className="text-ink-soft">
                  · {r.phone} · ✅{r.delivered}
                  {r.returned > 0 ? ` ↩️${r.returned}` : ""}
                </span>
              </p>
            ))}
          </div>
        </details>
      )}
    </main>
  );
}
