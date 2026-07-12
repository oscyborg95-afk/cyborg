"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import type {
  CashFlow,
  CustomerInsights,
  DeliverySpeed,
  Metrics,
  MonthStat,
  OutcomeStat,
  PnlWindow,
  ReorderItem,
} from "@/lib/metrics";
import type { AdSpend, BusinessSettings, Product, TemplateKey } from "@/lib/types";
import { DISTRICTS } from "@/lib/districts";
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
      <main className="mx-auto max-w-5xl space-y-5 p-5 sm:p-6" aria-busy="true" aria-label="Loading quest dashboard">
        <Card className="flex items-center gap-4 p-4">
          <Froggy mood="thinking" size={72} />
          <div>
            <p className="font-display text-lg font-extrabold text-ink">Loading your quest…</p>
            <p className="font-display text-sm font-bold text-ink-soft">Gathering today&apos;s orders, streak, and goals.</p>
          </div>
        </Card>
        <Card className="p-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
            <div className="h-40 w-40 shrink-0 animate-pulse rounded-full bg-track" />
            <div className="flex-1 space-y-3">
              <div className="h-7 w-2/3 animate-pulse rounded-lg bg-track" />
              <div className="h-4 w-1/2 animate-pulse rounded-lg bg-track" />
              <div className="h-5 w-full animate-pulse rounded-full bg-track" />
            </div>
          </div>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <Card key={item} className="space-y-3 p-4">
              <div className="h-5 w-3/4 animate-pulse rounded-lg bg-track" />
              <div className="h-12 animate-pulse rounded-xl bg-track" />
            </Card>
          ))}
        </div>
      </main>
    );
  }

  const levelComplete = metrics.levelProgressPct >= 100;
  const remaining = Math.max(0, metrics.levelTarget - metrics.levelCount);
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
      text: `👑 ${remaining} ${remaining === 1 ? "order" : "orders"} from Level ${metrics.level + 1}. I'm already practising my celebration dance.`,
      mood: "happy",
    });
  }
  if (metrics.bestStreakDays > 0 && streak < metrics.bestStreakDays) {
    coachLines.push({
      text: `📈 Record streak: ${metrics.bestStreakDays} days. Current: ${streak}. You gonna let past-you win?`,
      mood: "idle",
    });
  }
  // Hype the badge that's closest to unlocking (only when it's within reach).
  const nearBadge = metrics.badges
    .filter((b) => !b.earned && b.target && b.progress !== undefined && b.progress / b.target >= 0.6)
    .sort((a, b) => b.progress! / b.target! - a.progress! / a.target!)[0];
  if (nearBadge) {
    coachLines.push({
      text: `🏅 “${nearBadge.name}” is ${nearBadge.target! - nearBadge.progress!} away (${nearBadge.progress}/${nearBadge.target}). That badge is basically yours already.`,
      mood: "happy",
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
                  {metrics.levelCount} / {metrics.levelTarget} orders shipped
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
                  <span className="text-frog-dark">
                    {remaining} more {remaining === 1 ? "order" : "orders"}
                  </span>{" "}
                  to reach Level {metrics.level + 1}.
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
              {!b.earned && b.target !== undefined && b.progress !== undefined && b.progress > 0 && (
                <div className="mt-1 w-full">
                  <ProgressBar value={(b.progress / b.target) * 100} tone="var(--color-gold)" className="h-2" />
                  <span className="font-display text-[9px] font-extrabold text-ink-soft">
                    {b.progress.toLocaleString("en-LK")}/{b.target.toLocaleString("en-LK")}
                  </span>
                </div>
              )}
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
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Breakdown label="Bank cash" color="var(--color-sky)" value={metrics.netWorthBreakdown.bankCash} total={metrics.netWorth} />
          <Breakdown
            label={`Stock (${metrics.stockUnits} units)`}
            color="var(--color-grape)"
            value={metrics.netWorthBreakdown.stockValue}
            total={metrics.netWorth}
          />
          <Breakdown
            label="Cash in flight"
            color="var(--color-flame)"
            value={metrics.netWorthBreakdown.cashInFlight}
            total={metrics.netWorth}
          />
          <Breakdown
            label={`Awaiting payout (${metrics.awaitingPayoutCount})`}
            color="var(--color-gold)"
            value={metrics.netWorthBreakdown.awaitingPayout}
            total={metrics.netWorth}
          />
        </div>
        <p className="mt-4 font-display text-xs font-bold text-ink-soft">
          Buying stock just moves value from cash to inventory — your high score never drops for
          restocking. Only returns and spending outside the business can lower it. &ldquo;Awaiting
          payout&rdquo; is delivered COD the courier hasn&apos;t handed over — reconcile it on the{" "}
          <a href="/orders" className="underline">Orders page</a> when the payout lands.
        </p>
      </Card>

      {/* ── PROFIT & CASH-FLOW BRAIN ──────────────────────────────── */}
      <ProfitCard metrics={metrics} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CashFlowCard cash={metrics.cashFlow} />
        <ReorderRadar items={metrics.reorder} />
      </div>

      {/* ── DECISION REPORTS ──────────────────────────────────────── */}
      <MonthlyTrendCard months={metrics.months} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CustomerInsightsCard customers={metrics.customers} />
        <DeliverySpeedCard speed={metrics.speed} />
      </div>

      {/* ── WHERE RETURNS HAPPEN ──────────────────────────────────── */}
      {(metrics.districtStats.length > 0 || metrics.productStats.length > 0) && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ReturnRateCard
            title="📍 By district"
            hint="Completed journeys only (delivered + returned)."
            stats={metrics.districtStats}
          />
          <ReturnRateCard
            title="📦 By product"
            hint="High return rate = wrong expectations in the ad, or a quality issue."
            stats={metrics.productStats}
          />
        </div>
      )}

      {/* ── AD SPEND & ROAS ───────────────────────────────────────── */}
      <AdSpendCard metrics={metrics} />

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
          <TextField
            label={`Order ID prefix (e.g. ${settings.order_prefix || "DC"}-1001)`}
            value={settings.order_prefix}
            onChange={(v) => setSettings({ ...settings, order_prefix: v })}
          />
        </div>
        <p className="mt-2 font-display text-xs font-bold text-ink-soft">
          New orders get a short reference like{" "}
          <code className="rounded bg-cream px-1">{(settings.order_prefix || "DC") + "-1001"}</code>{" "}
          — this is the ID sent to the courier. Existing orders keep their number.
        </p>

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

        <h2 className="mb-1 mt-6 font-display text-lg font-extrabold text-ink">
          🚚 Courier rate card
        </h2>
        <p className="mb-4 font-display text-xs font-bold text-ink-soft">
          What the courier charges <em>you</em> — this is what makes the Profit &amp; loss numbers
          real. Set a base delivered fee, then override only the districts that cost more.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            label="Base delivered fee (Rs.)"
            value={settings.courier_cost_base}
            onChange={(v) => setSettings({ ...settings, courier_cost_base: v })}
          />
          <Field
            label="Return fee — round-trip loss (Rs.)"
            value={settings.courier_return_cost}
            onChange={(v) => setSettings({ ...settings, courier_return_cost: v })}
          />
        </div>
        <CourierOverridesEditor settings={settings} setSettings={setSettings} />

        <h2 className="mb-1 mt-6 font-display text-lg font-extrabold text-ink">
          🤖 AI address parsing
        </h2>
        <p className="mb-3 font-display text-xs font-bold text-ink-soft">
          Your own Gemini API key powers &ldquo;Parse from chat&rdquo;. Paste{" "}
          <strong>one key per line</strong> — when the free tier of one key hits its rate limit, the
          parser automatically rotates to the next. Get free keys at{" "}
          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noreferrer"
            className="text-sky-dark underline"
          >
            aistudio.google.com/apikey
          </a>
          .
        </p>
        <label className="block font-display text-xs font-bold text-ink-soft">
          Gemini API key(s)
          <textarea
            rows={3}
            spellCheck={false}
            autoComplete="off"
            placeholder={"AIzaSy…key-one\nAIzaSy…key-two (optional)"}
            className="mt-1.5 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2.5 font-mono text-sm font-semibold text-ink outline-none focus:border-frog"
            value={settings.gemini_api_key}
            onChange={(e) => setSettings({ ...settings, gemini_api_key: e.target.value })}
          />
        </label>
        <p className="mt-1.5 font-display text-[11px] font-bold text-ink-soft">
          {settings.gemini_api_key.trim()
            ? `${settings.gemini_api_key.split(/[\r\n]+/).filter((k) => k.trim()).length} key(s) saved — used before the server's built-in key.`
            : "No key set — parsing falls back to the server's GEMINI_API_KEY."}
        </p>

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

function ReturnRateCard({
  title,
  hint,
  stats,
}: {
  title: string;
  hint: string;
  stats: OutcomeStat[];
}) {
  const top = stats.slice(0, 8);
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-extrabold text-ink">{title}</h2>
      <p className="mb-3 font-display text-xs font-bold text-ink-soft">{hint}</p>
      {top.length === 0 ? (
        <p className="font-display text-sm font-bold text-ink-soft">
          No completed deliveries yet.
        </p>
      ) : (
        <div className="space-y-2">
          {top.map((s) => (
            <div key={s.name} className="flex items-center gap-3">
              <span className="w-32 truncate font-display text-sm font-bold text-ink" title={s.name}>
                {s.name}
              </span>
              <div className="h-3.5 flex-1 overflow-hidden rounded-full bg-[#f2ede3]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(s.returnRatePct, s.returned > 0 ? 4 : 0)}%`,
                    background:
                      s.returnRatePct >= 25 ? "var(--color-flame)" : "var(--color-gold)",
                  }}
                />
              </div>
              <span
                className={
                  "w-24 shrink-0 text-right font-display text-xs font-extrabold " +
                  (s.returnRatePct >= 25 ? "text-flame-dark" : "text-ink-soft")
                }
              >
                {s.returnRatePct}% · {s.returned}/{s.shipped} ret.
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Six months side by side — the "is this actually growing?" table. Same
// settlement-day accounting as the P&L card, so the columns reconcile.
function MonthlyTrendCard({ months }: { months: MonthStat[] }) {
  const hasData = months.some((m) => m.shipped > 0 || m.delivered > 0);
  const maxRevenue = Math.max(...months.map((m) => m.revenue), 1);
  return (
    <Card className="p-6">
      <h2 className="font-display text-lg font-extrabold text-ink">📈 Monthly trends</h2>
      <p className="mb-4 font-display text-xs font-bold text-ink-soft">
        Month over month — revenue counts when the parcel lands, so the current month grows as
        parcels settle.
      </p>
      {!hasData ? (
        <p className="font-display text-sm font-bold text-ink-soft">
          Ship a few orders and your first month shows up here.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-cardline/60" role="region" aria-label="Performance details table" tabIndex={0}>
          <table className="w-full min-w-[560px] border-separate border-spacing-y-1">
            <thead>
              <tr className="font-display text-[10px] font-extrabold uppercase tracking-wide text-ink-soft">
                <th className="px-2 text-left">Month</th>
                <th className="px-2 text-right">Shipped</th>
                <th className="px-2 text-right">Delivered</th>
                <th className="px-2 text-right">Returned</th>
                <th className="px-2 text-right">Revenue</th>
                <th className="px-2 text-right">Net profit</th>
                <th className="px-2 text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m, i) => {
                const current = i === months.length - 1;
                const profitable = m.netProfit >= 0;
                return (
                  <tr
                    key={m.key}
                    className={
                      "rounded-xl font-display text-sm font-bold " +
                      (current ? "bg-pond/60" : "bg-cream/70")
                    }
                  >
                    <td className="rounded-l-xl px-2 py-2 font-extrabold text-ink">
                      {m.label}
                      {current && (
                        <span className="ml-1.5 rounded-full bg-frog/20 px-1.5 py-0.5 text-[9px] font-extrabold text-frog-dark">
                          NOW
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-ink">{m.shipped}</td>
                    <td className="px-2 py-2 text-right tabular-nums text-frog-dark">{m.delivered}</td>
                    <td
                      className={
                        "px-2 py-2 text-right tabular-nums " +
                        (m.returned > 0 ? "text-flame-dark" : "text-ink-soft")
                      }
                    >
                      {m.returned}
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums text-ink">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-2 w-14 overflow-hidden rounded-full bg-[#e8e2d5]">
                          <div
                            className="h-full rounded-full bg-frog"
                            style={{ width: `${Math.round((m.revenue / maxRevenue) * 100)}%` }}
                          />
                        </div>
                        {rs(m.revenue)}
                      </div>
                    </td>
                    <td
                      className={
                        "px-2 py-2 text-right font-extrabold tabular-nums " +
                        (profitable ? "text-frog-dark" : "text-flame-dark")
                      }
                    >
                      {profitable ? "" : "−"}
                      {rs(Math.abs(m.netProfit))}
                    </td>
                    <td
                      className={
                        "rounded-r-xl px-2 py-2 text-right tabular-nums " +
                        (profitable ? "text-ink" : "text-flame-dark")
                      }
                    >
                      {m.marginPct}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// Repeat buyers: the cheapest revenue a COD shop has — no ad spend, and they
// already proved they open the door for the courier.
function CustomerInsightsCard({ customers }: { customers: CustomerInsights }) {
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-extrabold text-ink">💚 Customers</h2>
      <p className="mb-3 font-display text-xs font-bold text-ink-soft">
        Buyers who took delivery, and who keeps coming back.
      </p>
      {customers.buyers === 0 ? (
        <p className="font-display text-sm font-bold text-ink-soft">
          No delivered orders yet — customers appear once the first parcel lands.
        </p>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-cream/70 p-2.5 text-center">
              <p className="font-display text-xl font-extrabold text-ink">{customers.buyers}</p>
              <p className="font-display text-[10px] font-bold text-ink-soft">buyers</p>
            </div>
            <div className="rounded-xl bg-pond/60 p-2.5 text-center">
              <p className="font-display text-xl font-extrabold text-frog-dark">
                {customers.repeatRatePct}%
              </p>
              <p className="font-display text-[10px] font-bold text-ink-soft">
                buy again ({customers.repeatBuyers})
              </p>
            </div>
            <div className="rounded-xl bg-cream/70 p-2.5 text-center">
              <p className="font-display text-xl font-extrabold text-ink">
                {customers.repeatRevenuePct}%
              </p>
              <p className="font-display text-[10px] font-bold text-ink-soft">
                of revenue is repeat
              </p>
            </div>
          </div>
          <p className="mb-1.5 font-display text-[10px] font-extrabold uppercase tracking-wide text-ink-soft">
            Top customers
          </p>
          <div className="space-y-1.5">
            {customers.topCustomers.map((c, i) => (
              <div
                key={c.phone}
                className="flex items-center gap-2 rounded-xl bg-cream/70 px-3 py-1.5"
              >
                <span className="text-sm">{["🥇", "🥈", "🥉", "🏅", "🏅"][i]}</span>
                <span className="min-w-0 flex-1 truncate font-display text-sm font-bold text-ink">
                  {c.name}
                </span>
                <span className="shrink-0 font-display text-[11px] font-bold text-ink-soft">
                  {c.orders} {c.orders === 1 ? "order" : "orders"}
                </span>
                <span className="shrink-0 font-display text-sm font-extrabold tabular-nums text-frog-dark">
                  {rs(c.revenue)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// Dispatch → doorstep, in days. Slow districts sit on top: that's where COD
// refusals breed while the parcel rides.
function DeliverySpeedCard({ speed }: { speed: DeliverySpeed }) {
  const slowLine = speed.avgDays !== null ? speed.avgDays * 1.5 : Infinity;
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-extrabold text-ink">🛵 Delivery speed</h2>
      <p className="mb-3 font-display text-xs font-bold text-ink-soft">
        Dispatch to doorstep. Slow lanes breed refusals — chase the courier there.
      </p>
      {speed.avgDays === null ? (
        <p className="font-display text-sm font-bold text-ink-soft">
          Needs at least one tracked delivery to measure.
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-baseline gap-2 rounded-xl bg-pond/60 px-4 py-3">
            <span className="font-display text-3xl font-extrabold text-frog-dark">
              {speed.avgDays}
            </span>
            <span className="font-display text-sm font-bold text-ink">days average</span>
            <span className="ml-auto font-display text-[11px] font-bold text-ink-soft">
              {speed.measured} parcels measured
            </span>
          </div>
          <div className="space-y-1.5">
            {speed.byDistrict.slice(0, 8).map((d) => {
              const slow = d.avgDays >= slowLine && d.avgDays >= 3;
              return (
                <div
                  key={d.name}
                  className={
                    "flex items-center gap-2 rounded-xl px-3 py-1.5 " +
                    (slow ? "border-2 border-flame/50 bg-flame-tint" : "bg-cream/70")
                  }
                >
                  <span className="min-w-0 flex-1 truncate font-display text-sm font-bold text-ink">
                    {slow ? "🐢 " : ""}
                    {d.name}
                  </span>
                  <span className="shrink-0 font-display text-[11px] font-bold text-ink-soft">
                    {d.count} {d.count === 1 ? "parcel" : "parcels"}
                  </span>
                  <span
                    className={
                      "w-16 shrink-0 text-right font-display text-sm font-extrabold tabular-nums " +
                      (slow ? "text-flame-dark" : "text-ink")
                    }
                  >
                    {d.avgDays} d
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

// The profit brain's headline: a real P&L waterfall. The net-worth counter
// treats stock as an asset and never shows a loss for spending — this does.
// Revenue is delivered COD; every cost that ate into it is subtracted to land
// on the number that actually tells you if the business is working.
function ProfitCard({ metrics }: { metrics: Metrics }) {
  const [win, setWin] = useState<"month" | "last7">("month");
  const p: PnlWindow = win === "month" ? metrics.pnl.month : metrics.pnl.last7;
  const profitable = p.netProfit >= 0;
  const hasData = p.revenue > 0 || p.courierCost > 0 || p.adSpend > 0;
  const mood: FroggyMood = !hasData ? "idle" : profitable ? "celebrate" : "thinking";

  const rows: { label: string; value: number; sign: "+" | "−"; tone: string }[] = [
    { label: `Delivered revenue · ${p.deliveredCount} orders`, value: p.revenue, sign: "+", tone: "text-frog-dark" },
    { label: "Product cost (COGS)", value: p.cogs, sign: "−", tone: "text-ink-soft" },
    {
      label: `Courier fees · ${p.returnedCount} returned`,
      value: p.courierCost,
      sign: "−",
      tone: "text-ink-soft",
    },
    { label: "Ad spend", value: p.adSpend, sign: "−", tone: "text-ink-soft" },
  ];

  return (
    <Card className={"p-6 " + (hasData && profitable ? "!border-frog" : "")}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-extrabold text-ink">💰 Profit &amp; loss</h2>
        <div className="flex gap-1 rounded-xl bg-cream p-1">
          {(["month", "last7"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setWin(k)}
              className={
                "rounded-lg px-3 py-1 font-display text-xs font-extrabold transition " +
                (win === k ? "bg-frog text-white" : "text-ink-soft hover:text-ink")
              }
            >
              {k === "month" ? "This month" : "Last 7 days"}
            </button>
          ))}
        </div>
      </div>

      {!hasData ? (
        <div className="flex items-center gap-3 rounded-xl bg-cream/70 p-4">
          <Froggy mood="idle" size={54} />
          <p className="font-display text-sm font-bold text-ink-soft">
            No delivered orders in this window yet. Profit shows up here the moment a parcel lands.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <div className="flex-1 space-y-2">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3">
                <span className="font-display text-sm font-bold text-ink-soft">{r.label}</span>
                <span className={"font-display text-sm font-extrabold tabular-nums " + r.tone}>
                  {r.sign} {rs(r.value)}
                </span>
              </div>
            ))}
            <div className="mt-1 flex items-center justify-between gap-3 border-t-2 border-dashed border-cardline pt-2.5">
              <span className="font-display text-base font-extrabold text-ink">Net profit</span>
              <span
                className={
                  "font-display text-2xl font-extrabold tabular-nums " +
                  (profitable ? "text-frog-dark" : "text-flame-dark")
                }
              >
                {profitable ? "" : "−"}
                {rs(Math.abs(p.netProfit))}
              </span>
            </div>
          </div>

          <div className="flex shrink-0 flex-col items-center gap-1 rounded-2xl bg-pond/60 px-6 py-4 sm:w-44">
            <Froggy mood={mood} size={56} />
            <p className="font-display text-3xl font-extrabold leading-none text-ink">
              {p.marginPct}%
            </p>
            <p className="font-display text-xs font-bold text-ink-soft">net margin</p>
          </div>
        </div>
      )}

      {metrics.returnLoss.monthCount > 0 && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border-2 border-flame/40 bg-flame-tint px-3 py-2">
          <span className="text-lg">🩸</span>
          <p className="font-display text-xs font-extrabold text-flame-dark">
            Returns cost you {rs(metrics.returnLoss.monthLoss)} this month
            <span className="font-bold text-ink-soft">
              {" "}
              · {metrics.returnLoss.monthCount} round-trips with nothing to show
            </span>
          </p>
        </div>
      )}
      <p className="mt-3 font-display text-[11px] font-bold text-ink-soft">
        Revenue counts when a parcel is <em>delivered</em>. COGS uses each product&apos;s unit cost;
        courier fees come from your rate card in Settings. Set those to make these numbers real.
      </p>
    </Card>
  );
}

// Where the money actually sits right now — in hand, riding with couriers, or
// locked in inventory — and what's realistically going to land after returns.
function CashFlowCard({ cash }: { cash: CashFlow }) {
  const rows = [
    { label: "💵 Collected (in hand)", value: cash.collected, tone: "text-frog-dark" },
    { label: "🚚 Floating with couriers", value: cash.floating, tone: "text-flame-dark" },
    { label: "📦 Tied up in stock", value: cash.tiedInStock, tone: "text-grape-dark" },
  ];
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-extrabold text-ink">🏦 Cash flow</h2>
      <p className="mb-3 font-display text-xs font-bold text-ink-soft">
        Where your money is this moment.
      </p>
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-3 rounded-xl bg-cream/70 px-3 py-2">
            <span className="font-display text-sm font-bold text-ink">{r.label}</span>
            <span className={"font-display text-sm font-extrabold tabular-nums " + r.tone}>
              {rs(r.value)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-xl bg-pond/60 px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="font-display text-sm font-extrabold text-ink">🎯 Expected to land</span>
          <span className="font-display text-lg font-extrabold tabular-nums text-frog-dark">
            {rs(cash.expectedLanding)}
          </span>
        </div>
        <p className="mt-0.5 font-display text-[11px] font-bold text-ink-soft">
          In-flight COD, discounted by your {cash.returnRatePct}% return rate — what the parcels
          riding right now should really bring in.
        </p>
      </div>
    </Card>
  );
}

// Stock runway: how many days each product lasts at the last 14 days' pace.
// Under a week of cover is flagged red — reorder before you stock out.
function ReorderRadar({ items }: { items: ReorderItem[] }) {
  const cover = (r: ReorderItem) =>
    r.coverDays === null ? "—" : r.coverDays < 1 ? "<1 day" : `${Math.round(r.coverDays)} days`;
  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-extrabold text-ink">🛒 Reorder radar</h2>
      <p className="mb-3 font-display text-xs font-bold text-ink-soft">
        Days of stock left at your recent pace.
      </p>
      {items.length === 0 ? (
        <p className="font-display text-sm font-bold text-ink-soft">
          Add products with stock to see runway here.
        </p>
      ) : (
        <div className="space-y-2">
          {items.slice(0, 8).map((r) => (
            <div
              key={r.productId}
              className={
                "flex items-center gap-3 rounded-xl px-3 py-2 " +
                (r.urgent ? "border-2 border-flame/50 bg-flame-tint" : "bg-cream/70")
              }
            >
              <span className="min-w-0 flex-1 truncate font-display text-sm font-bold text-ink" title={r.name}>
                {r.urgent ? "⚠️ " : ""}
                {r.name}
              </span>
              <span className="shrink-0 font-display text-xs font-bold text-ink-soft">
                {r.stockUnits} in stock
              </span>
              <span
                className={
                  "w-20 shrink-0 text-right font-display text-sm font-extrabold " +
                  (r.urgent ? "text-flame-dark" : r.coverDays === null ? "text-ink-soft" : "text-ink")
                }
              >
                {cover(r)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Per-district courier-cost overrides. Collapsed by default; a blank field
// means "use the base fee", a number overrides just that district.
function CourierOverridesEditor({
  settings,
  setSettings,
}: {
  settings: BusinessSettings;
  setSettings: (s: BusinessSettings) => void;
}) {
  const overrides = settings.courier_cost_overrides ?? {};
  const count = Object.keys(overrides).length;

  function setDistrict(district: string, raw: string) {
    const next = { ...overrides };
    const v = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(v) || v < 0) delete next[district];
    else next[district] = v;
    setSettings({ ...settings, courier_cost_overrides: next });
  }

  return (
    <details className="mt-3 rounded-xl border-2 border-cardline bg-cream/50">
      <summary className="cursor-pointer select-none px-4 py-2.5 font-display text-sm font-extrabold text-ink">
        Per-district overrides
        {count > 0 && (
          <span className="ml-2 rounded-full bg-grape-tint px-2 py-0.5 font-display text-[10px] font-extrabold text-grape-dark">
            {count} set
          </span>
        )}
      </summary>
      <div className="grid grid-cols-2 gap-2 p-3 pt-0 sm:grid-cols-3 lg:grid-cols-4">
        {DISTRICTS.map((d) => (
          <label key={d} className="font-display text-[11px] font-bold text-ink-soft">
            {d}
            <input
              type="number"
              placeholder={`${settings.courier_cost_base}`}
              value={overrides[d] ?? ""}
              onChange={(e) => setDistrict(d, e.target.value)}
              className="mt-0.5 w-full rounded-lg border-2 border-cardline bg-white px-2 py-1.5 font-display text-sm font-bold text-ink outline-none focus:border-frog"
            />
          </label>
        ))}
      </div>
    </details>
  );
}

// Manual daily ad-spend entry + delivered-revenue ROAS. Revenue counts on the
// day the parcel is DELIVERED (when COD becomes real money), so early days of
// a campaign will look worse than they are — parcels take 1–3 days to land.
function AdSpendCard({ metrics }: { metrics: Metrics }) {
  const [spend, setSpend] = useState<AdSpend[]>([]);
  const [day, setDay] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/adspend");
    const data = await res.json();
    if (res.ok) setSpend(data.spend);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Editing an existing day pre-fills its current amount.
  useEffect(() => {
    const existing = spend.find((s) => s.day === day);
    setAmount(existing ? String(existing.amount) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, spend.length]);

  async function save() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) return;
    setBusy(true);
    await fetch("/api/adspend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ day, amount: value }),
    });
    await load();
    setBusy(false);
  }

  const { last7, last14 } = metrics.adPerf;
  const roas = (w: { spend: number; revenue: number }) =>
    w.spend > 0 ? (w.revenue / w.spend).toFixed(2) : null;
  const cpa = (w: { spend: number; deliveredCount: number }) =>
    w.spend > 0 && w.deliveredCount > 0 ? Math.round(w.spend / w.deliveredCount) : null;

  const inputCls =
    "mt-1 w-full rounded-xl border-2 border-cardline bg-cream/60 px-3 py-2 font-display text-sm font-bold text-ink outline-none focus:border-frog";

  return (
    <Card className="p-6">
      <h2 className="mb-1 font-display text-lg font-extrabold text-ink">📣 Ad spend &amp; ROAS</h2>
      <p className="mb-4 font-display text-xs font-bold text-ink-soft">
        Log what you spent on Meta each day. ROAS = delivered COD revenue ÷ spend — revenue counts
        when the parcel is <em>delivered</em>, so give fresh campaigns 2–3 days before judging.
      </p>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <PerfTile label="Spend (7d)" value={rs(last7.spend)} />
        <PerfTile
          label="Delivered revenue (7d)"
          value={rs(last7.revenue)}
          sub={`${last7.deliveredCount} orders`}
        />
        <PerfTile
          label="ROAS (7d)"
          value={roas(last7) ? `${roas(last7)}×` : "—"}
          highlight={last7.spend > 0 && last7.revenue >= last7.spend * 3}
          sub={cpa(last7) ? `Rs. ${cpa(last7)!.toLocaleString("en-LK")} / delivery` : undefined}
        />
        <PerfTile
          label="ROAS (14d)"
          value={roas(last14) ? `${roas(last14)}×` : "—"}
          sub={`${rs(last14.spend)} spent`}
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="font-display text-xs font-bold text-ink-soft">
          Day
          <input type="date" className={inputCls} value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        <label className="font-display text-xs font-bold text-ink-soft">
          Spend (Rs.)
          <input
            type="number"
            className={inputCls}
            placeholder="e.g. 2500"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <Button tone="frog" onClick={save} disabled={busy || amount === ""}>
          {busy ? "Saving…" : "💾 Save day"}
        </Button>
      </div>

      {spend.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {spend.slice(0, 14).map((s) => (
            <button
              key={s.day}
              onClick={() => setDay(s.day)}
              className="rounded-full bg-cream px-2.5 py-1 font-display text-[11px] font-bold text-ink-soft transition hover:bg-pond hover:text-frog-dark"
              title="Tap to edit"
            >
              {s.day.slice(5)} · {rs(s.amount)}
            </button>
          ))}
        </div>
      )}
    </Card>
  );
}

function PerfTile({
  label,
  value,
  sub,
  highlight = false,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div className={"rounded-xl p-3 " + (highlight ? "bg-pond" : "bg-cream/70")}>
      <p className="font-display text-xs font-bold text-ink-soft">{label}</p>
      <p className={"font-display text-xl font-extrabold " + (highlight ? "text-frog-dark" : "text-ink")}>
        {value}
      </p>
      {sub && <p className="font-display text-[11px] font-bold text-ink-soft">{sub}</p>}
    </div>
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
