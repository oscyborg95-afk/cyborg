"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import type { Metrics } from "@/lib/metrics";
import type { BusinessSettings, Product, TemplateKey } from "@/lib/types";
import { DEFAULT_TEMPLATES, TEMPLATE_META } from "@/lib/templates";
import { Froggy, type FroggyMood } from "../components/froggy";
import {
  ActivityChart,
  Button,
  Card,
  Confetti,
  CountUp,
  Flame,
  ProgressBar,
  ProgressRing,
} from "../components/ui";
import { Coach, useColomboCountdown, type CoachLine } from "../components/coach";
import { BadgeQueue, LevelUpOverlay, useCelebrations } from "../components/celebrations";

const rs = (n: number) => `Rs. ${Math.round(n).toLocaleString("en-LK")}`;

export default function QuestPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [saving, setSaving] = useState(false);
  const [celebrate, setCelebrate] = useState(false);
  const { levelUp, newBadges, dismissLevelUp, dismissBadges } = useCelebrations(metrics);
  const countdown = useColomboCountdown();

  const load = useCallback(async () => {
    const [metricsRes, productsRes] = await Promise.all([
      fetch("/api/metrics"),
      fetch("/api/products"),
    ]);
    const data = await metricsRes.json();
    if (metricsRes.ok) {
      setMetrics(data.metrics);
      setSettings(data.settings);
    }
    const productsData = await productsRes.json();
    if (productsRes.ok) setProducts(productsData.products);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Fire confetti once when the board loads on a completed level.
  useEffect(() => {
    if (metrics && metrics.levelProgressPct >= 100) {
      setCelebrate(true);
      const t = setTimeout(() => setCelebrate(false), 3600);
      return () => clearTimeout(t);
    }
  }, [metrics]);

  // ALL-CLEAR moment: confetti the first time today's quest board is swept.
  useEffect(() => {
    if (!metrics || !metrics.quests.every((q) => q.done)) return;
    const today = metrics.days[metrics.days.length - 1]?.key ?? "";
    try {
      if (localStorage.getItem("dc:questsClearDay") === today) return;
      localStorage.setItem("dc:questsClearDay", today);
    } catch {}
    setCelebrate(true);
    const t = setTimeout(() => setCelebrate(false), 3600);
    return () => clearTimeout(t);
  }, [metrics]);

  async function saveSettings() {
    if (!settings) return;
    setSaving(true);
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    await load();
    setSaving(false);
  }

  if (!metrics || !settings) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-soft">
        <Froggy mood="thinking" size={110} />
        <p className="font-display text-lg font-bold">Loading your quest…</p>
      </div>
    );
  }

  const levelComplete = metrics.levelProgressPct >= 100;
  const remaining = Math.max(0, metrics.levelTarget - metrics.delivered);
  const streak = metrics.dispatchStreakDays;
  const heroMood: FroggyMood = levelComplete ? "celebrate" : streak > 0 ? "happy" : "idle";
  const allQuestsDone = metrics.quests.every((q) => q.done);

  // Cash's board-side commentary — urgency first, then hype.
  const coachLines: CoachLine[] = [];
  if (metrics.streakAtRisk) {
    coachLines.push({
      text: `🚨 RED ALERT! Your ${streak}-day streak burns out in ${countdown.label}. One dispatch. That's all it takes.`,
      mood: "idle",
    });
  }
  if (allQuestsDone) {
    coachLines.push({
      text: "🏆 Every quest CLEARED. Absolute legend behaviour. See you at midnight for a fresh board!",
      mood: "celebrate",
    });
  } else {
    const next = metrics.quests.find((q) => !q.done);
    if (next) {
      coachLines.push({
        text: `⚔️ Next up: “${next.label}” — ${next.target - next.progress} to go. I believe in you. Mostly.`,
        mood: "happy",
      });
    }
  }
  if (!levelComplete && remaining <= 5) {
    coachLines.push({
      text: `👑 ${remaining} ${remaining === 1 ? "delivery" : "deliveries"} from Level ${metrics.level + 1}. I'm already practising my celebration dance.`,
      mood: "happy",
    });
  }
  if (metrics.bestStreakDays > 0 && streak < metrics.bestStreakDays) {
    coachLines.push({
      text: `📈 Record streak: ${metrics.bestStreakDays} days. Current: ${streak}. You gonna let past-you win?`,
      mood: "idle",
    });
  }
  if (coachLines.length === 0) {
    coachLines.push({ text: "Ship one parcel and the whole board lights up. Let's gooo! 🐸", mood: "happy" });
  }

  return (
    <main className="mx-auto max-w-5xl space-y-5 p-5 sm:p-6">
      <Confetti run={celebrate} />
      {levelUp !== null && <LevelUpOverlay level={levelUp} onClose={dismissLevelUp} />}
      {levelUp === null && newBadges.length > 0 && (
        <BadgeQueue badges={newBadges} onDone={dismissBadges} />
      )}

      {/* ── CASH THE COACH ────────────────────────────────────────── */}
      <Card className="p-4">
        <Coach lines={coachLines} size={72} />
      </Card>

      {/* ── HERO: level ring + mascot ─────────────────────────────── */}
      <Card
        className={
          "relative overflow-hidden p-6 " +
          (levelComplete ? "!border-gold shadow-[0_10px_0_-2px_rgba(255,200,0,0.35)]" : "")
        }
      >
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-8">
          <ProgressRing
            value={metrics.levelProgressPct}
            size={190}
            stroke={18}
            color={levelComplete ? "var(--color-gold)" : "var(--color-frog)"}
          >
            <span className="font-display text-xs font-bold uppercase tracking-widest text-ink-soft">
              Level
            </span>
            <span
              className="font-display text-6xl font-extrabold leading-none text-ink"
              style={levelComplete ? { animation: "count-glow 1.6s ease-in-out infinite" } : undefined}
            >
              {metrics.level}
            </span>
            <span className="mt-1 font-display text-sm font-bold text-frog-dark">
              {metrics.levelProgressPct}%
            </span>
          </ProgressRing>

          <div className="flex-1 text-center sm:text-left">
            <div className="mb-1 flex items-center justify-center gap-3 sm:justify-start">
              <Froggy mood={heroMood} size={72} />
              <div>
                <h1 className="font-display text-2xl font-extrabold text-ink">
                  Level {metrics.level} Operator
                </h1>
                <p className="font-display text-sm font-bold text-ink-soft">
                  {metrics.delivered} / {metrics.levelTarget} orders delivered
                </p>
              </div>
            </div>
            <ProgressBar
              value={metrics.levelProgressPct}
              tone={levelComplete ? "var(--color-gold)" : "var(--color-frog)"}
              className="mt-4"
            />
            <p className="mt-3 font-display text-sm font-bold text-ink">
              {levelComplete ? (
                <span className="text-gold-dark">
                  🎉 Level {metrics.level} complete — next tier unlocked! Keep the volume up.
                </span>
              ) : (
                <>
                  <span className="text-frog-dark">{remaining} more deliveries</span> to reach Level{" "}
                  {metrics.level + 1}.
                </>
              )}
            </p>
          </div>
        </div>
      </Card>

      {/* ── DAILY QUESTS: the reason to come back tomorrow ────────── */}
      <Card className={"p-6 " + (metrics.quests.every((q) => q.done) ? "!border-gold" : "")}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-extrabold text-ink">⚔️ Today&apos;s quests</h2>
          {metrics.quests.every((q) => q.done) ? (
            <span className="animate-pop rounded-full bg-gold/25 px-3 py-1 font-display text-xs font-extrabold text-gold-dark">
              ALL CLEAR — legend behaviour 🏆
            </span>
          ) : (
            <span className="font-display text-xs font-bold text-ink-soft">
              Resets at midnight
            </span>
          )}
        </div>
        <div className="space-y-3">
          {metrics.quests.map((q) => (
            <div key={q.id} className="flex items-center gap-3">
              <div
                className={
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-xl " +
                  (q.done ? "bg-pond" : "bg-[#f2ede3]")
                }
              >
                {q.done ? "✅" : q.emoji}
              </div>
              <div className="min-w-0 flex-1">
                <p
                  className={
                    "font-display text-sm font-extrabold " +
                    (q.done ? "text-frog-dark" : "text-ink")
                  }
                >
                  {q.label}
                </p>
                <ProgressBar
                  value={(q.progress / q.target) * 100}
                  tone={q.done ? "var(--color-frog)" : "var(--color-gold)"}
                  className="mt-1.5 h-3.5"
                />
              </div>
              <span className="shrink-0 font-display text-sm font-extrabold text-ink-soft">
                {q.progress}/{q.target}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {/* ── STREAK ────────────────────────────────────────────────── */}
      <Card className="p-6">
        <div className="flex flex-col items-center gap-5 sm:flex-row sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-flame-tint">
              <Flame size={54} dim={streak === 0} />
            </div>
            <div>
              <p className="font-display text-5xl font-extrabold leading-none text-flame-dark">
                {streak}
              </p>
              <p className="font-display text-sm font-bold text-ink-soft">
                day dispatch streak {streak > 0 ? "🔥" : ""}
              </p>
            </div>
          </div>

          <div className="flex flex-col items-center gap-2 sm:items-end">
            <div className="flex gap-1.5">
              {Array.from({ length: 7 }).map((_, i) => {
                const lit = i >= 7 - Math.min(streak, 7);
                return (
                  <div
                    key={i}
                    className={
                      "flex h-9 w-9 items-center justify-center rounded-xl " +
                      (lit ? "bg-flame-tint" : "bg-[#f2ede3]")
                    }
                  >
                    <Flame size={20} dim={!lit} />
                  </div>
                );
              })}
            </div>
            {metrics.streakAtRisk ? (
              <p className="danger-pulse rounded-xl border-2 border-flame bg-flame-tint px-3 py-1.5 font-display text-xs font-extrabold text-flame-dark">
                ⚠️ At risk! Ship one order in the next ⏰ {countdown.label} to save it!
              </p>
            ) : (
              <p className="font-display text-xs font-bold text-ink-soft">
                {streak > 0
                  ? "Safe for today — see you tomorrow. 😌"
                  : "Dispatch an order today to start a streak."}
              </p>
            )}
            <p className="font-display text-xs font-bold text-ink-soft">
              Record streak: <span className="text-flame-dark">{metrics.bestStreakDays} days</span>
              {" · "}Best day: <span className="text-flame-dark">{metrics.bestDay} parcels</span>
            </p>
          </div>
        </div>
      </Card>

      {/* ── 14-DAY ACTIVITY CHART ─────────────────────────────────── */}
      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-extrabold text-ink">📊 Last 14 days</h2>
          <span className="font-display text-xs font-bold text-ink-soft">
            {metrics.days.reduce((s, d) => s + d.dispatched, 0)} dispatched ·{" "}
            {metrics.days.reduce((s, d) => s + d.delivered, 0)} delivered
          </span>
        </div>
        <ActivityChart days={metrics.days} goal={metrics.dailyGoal} />
      </Card>

      {/* ── STAT TILES ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile
          tint="bg-pond"
          emoji="🏆"
          label="Total wins"
          value={<CountUp value={metrics.totalPackages} />}
          sub="packages dispatched"
        />
        <StatTile
          tint="bg-sky-tint"
          emoji="🚚"
          label="Cash in flight"
          value={<CountUp value={metrics.cashInFlight} format={rs} />}
          sub="riding with the courier"
        />
        <StatTile
          tint="bg-grape-tint"
          emoji="✅"
          label="Delivered"
          value={<CountUp value={metrics.delivered} />}
          sub="orders completed"
        />
      </div>

      {/* ── BADGES: the trophy cabinet ────────────────────────────── */}
      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-extrabold text-ink">🎖️ Badges</h2>
          <span className="font-display text-xs font-extrabold text-ink-soft">
            {metrics.badges.filter((b) => b.earned).length}/{metrics.badges.length} earned
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {metrics.badges.map((b) => (
            <div
              key={b.id}
              title={b.desc}
              className={
                "flex flex-col items-center gap-1 rounded-2xl border-2 p-3 text-center transition " +
                (b.earned
                  ? "border-gold bg-gold/15"
                  : "border-cardline bg-[#f2ede3] opacity-55 grayscale")
              }
            >
              <span className="text-3xl">{b.earned ? b.emoji : "🔒"}</span>
              <span className="font-display text-xs font-extrabold leading-tight text-ink">
                {b.name}
              </span>
              <span className="font-display text-[10px] font-bold leading-tight text-ink-soft">
                {b.desc}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {/* ── NET WORTH: the high score ─────────────────────────────── */}
      <Card className="!border-frog p-6">
        <p className="font-display text-xs font-extrabold uppercase tracking-widest text-frog-dark">
          🎯 High score · Business net worth
        </p>
        <p className="mt-1 font-display text-5xl font-extrabold text-ink">
          <CountUp value={metrics.netWorth} format={rs} />
        </p>
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Breakdown label="Bank cash" color="var(--color-sky)" value={metrics.netWorthBreakdown.bankCash} total={metrics.netWorth} />
          <Breakdown
            label={`Stock (${metrics.stockUnits} units)`}
            color="var(--color-grape)"
            value={metrics.netWorthBreakdown.stockValue}
            total={metrics.netWorth}
          />
          <Breakdown
            label="Pending remittances"
            color="var(--color-flame)"
            value={metrics.netWorthBreakdown.pendingRemittances}
            total={metrics.netWorth}
          />
        </div>
        <p className="mt-4 font-display text-xs font-bold text-ink-soft">
          Buying stock just moves value from cash to inventory — your high score never drops for
          restocking. Only returns and spending outside the business can lower it.
        </p>
      </Card>

      {/* ── PRODUCTS & STOCK ──────────────────────────────────────── */}
      <ProductsCard products={products} onChanged={load} />

      {/* ── SETTINGS ──────────────────────────────────────────────── */}
      <Card className="p-6">
        <h2 className="mb-4 font-display text-lg font-extrabold text-ink">🏪 Business profile</h2>
        <p className="-mt-3 mb-4 font-display text-xs font-bold text-ink-soft">
          Printed on every invoice.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Business name"
            value={settings.business_name}
            onChange={(v) => setSettings({ ...settings, business_name: v })}
          />
          <TextField
            label="Business address"
            value={settings.business_address}
            onChange={(v) => setSettings({ ...settings, business_address: v })}
          />
          <TextField
            label="Phone 1"
            value={settings.business_phone_1}
            onChange={(v) => setSettings({ ...settings, business_phone_1: v })}
          />
          <TextField
            label="Phone 2 (optional)"
            value={settings.business_phone_2}
            onChange={(v) => setSettings({ ...settings, business_phone_2: v })}
          />
        </div>

        <h2 className="mb-4 mt-6 font-display text-lg font-extrabold text-ink">
          ⚙️ High-score inputs
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field
            label="Bank cash (Rs.)"
            value={settings.bank_cash}
            onChange={(v) => setSettings({ ...settings, bank_cash: v })}
          />
          <Field
            label="Other stock (units, not in products)"
            value={settings.stock_units}
            onChange={(v) => setSettings({ ...settings, stock_units: v })}
          />
          <Field
            label="Other stock unit cost (Rs.)"
            step="0.01"
            value={settings.stock_unit_cost}
            onChange={(v) => setSettings({ ...settings, stock_unit_cost: v })}
          />
        </div>
        <Button tone="frog" onClick={saveSettings} disabled={saving} className="mt-5">
          {saving ? "Saving…" : "Save & recalculate"}
        </Button>
      </Card>

      {/* ── WHATSAPP MESSAGE TEMPLATES ────────────────────────────── */}
      <Card className="p-6">
        <h2 className="mb-1 font-display text-lg font-extrabold text-ink">
          💬 WhatsApp message templates
        </h2>
        <p className="mb-4 font-display text-xs font-bold text-ink-soft">
          These are the exact texts the action buttons send. Placeholders like{" "}
          <code className="rounded bg-cream px-1">{"{{total}}"}</code> and{" "}
          <code className="rounded bg-cream px-1">{"{{tracking}}"}</code> are filled in
          automatically — a line with a missing placeholder is dropped from the message.
        </p>
        <div className="space-y-4">
          {(Object.keys(TEMPLATE_META) as TemplateKey[]).map((key) => {
            const meta = TEMPLATE_META[key];
            const overridden = Boolean(settings.templates?.[key]);
            return (
              <div key={key} className="rounded-xl border-2 border-cardline bg-cream/50 p-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="font-display text-sm font-extrabold text-ink">
                    {meta.label}
                    {overridden && (
                      <span className="ml-2 rounded-full bg-grape-tint px-2 py-0.5 font-display text-[10px] font-extrabold text-grape-dark">
                        customized
                      </span>
                    )}
                  </p>
                  <div className="flex items-center gap-2">
                    {meta.placeholders.map((ph) => (
                      <code
                        key={ph}
                        className="rounded-md bg-white px-1.5 py-0.5 font-mono text-[10px] font-bold text-sky-dark"
                      >
                        {ph}
                      </code>
                    ))}
                    {overridden && (
                      <button
                        onClick={() =>
                          setSettings({
                            ...settings,
                            templates: { ...settings.templates, [key]: undefined },
                          })
                        }
                        className="rounded-lg px-2 py-0.5 font-display text-xs font-bold text-flame-dark hover:bg-flame-tint"
                      >
                        ↺ Reset
                      </button>
                    )}
                  </div>
                </div>
                <p className="mb-2 font-display text-[11px] font-bold text-ink-soft">{meta.hint}</p>
                <textarea
                  rows={key === "shippedConfirmation" ? 7 : 4}
                  className="w-full rounded-xl border-2 border-cardline bg-white px-3 py-2 text-sm font-semibold text-ink outline-none focus:border-frog"
                  value={settings.templates?.[key] ?? DEFAULT_TEMPLATES[key]}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      templates: { ...settings.templates, [key]: e.target.value },
                    })
                  }
                />
              </div>
            );
          })}
        </div>
        <Button tone="frog" onClick={saveSettings} disabled={saving} className="mt-4">
          {saving ? "Saving…" : "💾 Save templates"}
        </Button>
      </Card>
    </main>
  );
}

function ProductsCard({ products, onChanged }: { products: Product[]; onChanged: () => void }) {
  const [draft, setDraft] = useState({ name: "", price: "", unit_cost: "", stock_units: "" });
  const [busy, setBusy] = useState(false);
  const [receivingId, setReceivingId] = useState<string | null>(null);

  async function add() {
    if (!draft.name.trim()) return;
    setBusy(true);
    await fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: draft.name.trim(),
        price: Number(draft.price || 0),
        unit_cost: Number(draft.unit_cost || 0),
        stock_units: Number(draft.stock_units || 0),
      }),
    });
    setDraft({ name: "", price: "", unit_cost: "", stock_units: "" });
    onChanged();
    setBusy(false);
  }

  async function patch(id: string, body: Partial<Product>) {
    await fetch(`/api/products/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    onChanged();
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Delete "${name}"? Past orders keep their history.`)) return;
    await fetch(`/api/products/${id}`, { method: "DELETE" });
    onChanged();
  }

  const miniInput =
    "w-full rounded-lg border-2 border-cardline bg-cream/60 px-2 py-1.5 font-display text-sm font-bold text-ink outline-none focus:border-frog";

  return (
    <Card className="p-6">
      <h2 className="mb-1 font-display text-lg font-extrabold text-ink">📦 Products &amp; stock</h2>
      <p className="mb-4 font-display text-xs font-bold text-ink-soft">
        Tap-to-fill presets in the dispatch form. Stock moves itself: −1 when an order books,
        +1 when a courier return comes back. Use <strong>＋ Buy new stock</strong> when you
        restock — it blends the new cost into a weighted-average unit cost.
      </p>

      {products.length > 0 && (
        <div className="mb-4 space-y-2">
          <div className="hidden grid-cols-[1fr_90px_90px_90px_70px] gap-2 px-1 font-display text-[10px] font-extrabold uppercase tracking-wide text-ink-soft sm:grid">
            <span>Product</span>
            <span>Price</span>
            <span>Unit cost</span>
            <span>In stock</span>
            <span />
          </div>
          {products.map((p) => (
            <Fragment key={p.id}>
            <div
              className="grid grid-cols-2 items-center gap-2 rounded-xl bg-cream/70 p-2 sm:grid-cols-[1fr_90px_90px_90px_70px]"
            >
              <input
                className={miniInput}
                defaultValue={p.name}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== p.name) patch(p.id, { name });
                }}
              />
              <input
                type="number"
                className={miniInput}
                defaultValue={p.price}
                onBlur={(e) => {
                  const price = Number(e.target.value);
                  if (!Number.isNaN(price) && price !== p.price) patch(p.id, { price });
                }}
              />
              <input
                type="number"
                className={miniInput}
                defaultValue={p.unit_cost}
                onBlur={(e) => {
                  const unit_cost = Number(e.target.value);
                  if (!Number.isNaN(unit_cost) && unit_cost !== p.unit_cost)
                    patch(p.id, { unit_cost });
                }}
              />
              <div className="flex items-center gap-1">
                <button
                  onClick={() => patch(p.id, { stock_units: Math.max(0, p.stock_units - 1) })}
                  className="h-8 w-8 rounded-lg bg-[#f2ede3] font-display font-extrabold text-ink hover:bg-flame-tint"
                >
                  −
                </button>
                <span
                  className={
                    "min-w-8 text-center font-display text-sm font-extrabold " +
                    (p.stock_units <= 0 ? "text-[#c04545]" : "text-ink")
                  }
                >
                  {p.stock_units}
                </span>
                <button
                  onClick={() => patch(p.id, { stock_units: p.stock_units + 1 })}
                  className="h-8 w-8 rounded-lg bg-[#f2ede3] font-display font-extrabold text-ink hover:bg-pond"
                >
                  +
                </button>
              </div>
              <div className="flex justify-end gap-1">
                <button
                  onClick={() => setReceivingId(receivingId === p.id ? null : p.id)}
                  className="rounded-lg px-2 py-1 font-display text-xs font-bold text-frog-dark hover:bg-pond"
                  title="Buy new stock (updates average cost)"
                >
                  {receivingId === p.id ? "Cancel" : "＋ Buy"}
                </button>
                <button
                  onClick={() => remove(p.id, p.name)}
                  className="rounded-lg px-2 py-1 font-display text-xs font-bold text-ink-soft hover:bg-flame-tint hover:text-[#c04545]"
                >
                  Delete
                </button>
              </div>
            </div>
            {receivingId === p.id && (
              <ReceiveRow
                product={p}
                onDone={() => {
                  setReceivingId(null);
                  onChanged();
                }}
              />
            )}
            </Fragment>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_90px_90px_90px_auto]">
        <label className="font-display text-xs font-bold text-ink-soft">
          New product
          <input
            className={`${miniInput} mt-1`}
            placeholder="e.g. Posture Corrector"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label className="font-display text-xs font-bold text-ink-soft">
          Price
          <input
            type="number"
            className={`${miniInput} mt-1`}
            value={draft.price}
            onChange={(e) => setDraft({ ...draft, price: e.target.value })}
          />
        </label>
        <label className="font-display text-xs font-bold text-ink-soft">
          Unit cost
          <input
            type="number"
            className={`${miniInput} mt-1`}
            value={draft.unit_cost}
            onChange={(e) => setDraft({ ...draft, unit_cost: e.target.value })}
          />
        </label>
        <label className="font-display text-xs font-bold text-ink-soft">
          Stock
          <input
            type="number"
            className={`${miniInput} mt-1`}
            value={draft.stock_units}
            onChange={(e) => setDraft({ ...draft, stock_units: e.target.value })}
          />
        </label>
        <Button tone="frog" onClick={add} disabled={busy || !draft.name.trim()}>
          + Add
        </Button>
      </div>
    </Card>
  );
}

// Buy-new-stock panel: enter quantity + this purchase's unit cost, preview the
// resulting weighted-average cost, then commit.
function ReceiveRow({ product, onDone }: { product: Product; onDone: () => void }) {
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState(product.unit_cost ? String(product.unit_cost) : "");
  const [busy, setBusy] = useState(false);

  const q = Number(qty || 0);
  const c = Number(cost || 0);
  const newStock = product.stock_units + (q > 0 ? q : 0);
  const newAvg =
    newStock > 0 ? (product.stock_units * product.unit_cost + q * c) / newStock : c;

  async function confirm() {
    if (q <= 0) return;
    setBusy(true);
    await fetch(`/api/products/${product.id}/receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity: q, unit_cost: c }),
    });
    setBusy(false);
    onDone();
  }

  const field =
    "w-24 rounded-lg border-2 border-cardline bg-white px-2 py-1.5 font-display text-sm font-bold text-ink outline-none focus:border-frog";

  return (
    <div className="mb-2 rounded-xl border-2 border-frog/40 bg-pond/40 p-3">
      <p className="mb-2 font-display text-xs font-extrabold text-ink">
        📥 Buy new stock — {product.name}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="font-display text-xs font-bold text-ink-soft">
          Quantity
          <input
            type="number"
            className={`${field} mt-1`}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="e.g. 50"
            autoFocus
          />
        </label>
        <label className="font-display text-xs font-bold text-ink-soft">
          Cost per unit (Rs.)
          <input
            type="number"
            step="0.01"
            className={`${field} mt-1`}
            value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </label>
        <Button tone="frog" onClick={confirm} disabled={busy || q <= 0}>
          {busy ? "Adding…" : "Add stock"}
        </Button>
      </div>
      {q > 0 && (
        <p className="mt-2 font-display text-xs font-bold text-ink-soft">
          → New stock: <span className="text-ink">{newStock}</span> units · New avg cost:{" "}
          <span className="text-ink">Rs. {newAvg.toFixed(2)}</span>
          {Math.abs(c - product.unit_cost) > 0.001 && (
            <span> (was Rs. {product.unit_cost.toFixed(2)})</span>
          )}
        </p>
      )}
    </div>
  );
}

function StatTile({
  tint,
  emoji,
  label,
  value,
  sub,
}: {
  tint: string;
  emoji: string;
  label: string;
  value: React.ReactNode;
  sub: string;
}) {
  return (
    <Card className="p-5">
      <div className={`mb-3 flex h-11 w-11 items-center justify-center rounded-xl text-2xl ${tint}`}>
        {emoji}
      </div>
      <p className="font-display text-xs font-extrabold uppercase tracking-wide text-ink-soft">
        {label}
      </p>
      <p className="mt-0.5 font-display text-3xl font-extrabold text-ink">{value}</p>
      <p className="font-display text-xs font-bold text-ink-soft">{sub}</p>
    </Card>
  );
}

function Breakdown({
  label,
  color,
  value,
  total,
}: {
  label: string;
  color: string;
  value: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-xl bg-cream/70 p-3">
      <p className="font-display text-xs font-bold text-ink-soft">{label}</p>
      <p className="font-display text-lg font-extrabold text-ink">{rs(value)}</p>
      <ProgressBar value={pct} tone={color} className="mt-2 h-3" />
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block font-display text-xs font-bold text-ink-soft">
      {label}
      <input
        type="text"
        className="mt-1.5 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 font-display text-base font-bold text-ink outline-none focus:border-frog"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Field({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: string;
}) {
  return (
    <label className="block font-display text-xs font-bold text-ink-soft">
      {label}
      <input
        type="number"
        step={step}
        className="mt-1.5 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 font-display text-base font-bold text-ink outline-none focus:border-frog"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
