import type {
  BusinessSettings,
  Order,
  Product,
  ShippingManifest,
  TrackingEvent,
} from "./types";

// Level thresholds by cumulative DELIVERED orders. Level N is complete at LEVELS[N].
export const LEVELS = [10, 50, 150, 400, 1000];

// A daily quest: do the thing `target` times before midnight.
export interface Quest {
  id: string;
  emoji: string;
  label: string;
  progress: number;
  target: number;
  done: boolean;
}

// A permanent achievement. Once the underlying record is set it never un-earns.
export interface Badge {
  id: string;
  emoji: string;
  name: string;
  desc: string;
  earned: boolean;
}

// One bar of the activity chart: everything that happened on one Colombo day.
export interface DayStat {
  key: string; // YYYY-MM-DD in Asia/Colombo
  label: string; // short weekday label, e.g. "Mon"
  dispatched: number;
  delivered: number;
  returned: number;
}

export interface Metrics {
  level: number;
  levelTarget: number;
  levelBase: number;
  delivered: number;
  levelProgressPct: number;
  totalPackages: number; // everything ever handed to a courier
  dispatchStreakDays: number;
  bestStreakDays: number; // longest streak ever (records never un-earn)
  streakAtRisk: boolean; // streak alive but nothing shipped yet today
  shippedToday: number;
  dailyGoal: number; // adaptive: beats your recent average, never crushing
  bestDay: number; // most packages ever shipped in one day
  cashInFlight: number; // COD value riding with the courier right now
  stockUnits: number; // total physical units in the shed (products + legacy settings)
  netWorth: number;
  netWorthBreakdown: {
    bankCash: number;
    stockValue: number;
    pendingRemittances: number;
  };
  quests: Quest[];
  badges: Badge[];
  days: DayStat[]; // last 14 Colombo days, oldest first — feeds the Quest chart
}

// The operator ships on Sri Lanka time. Bucketing an instant by the server's
// local calendar (UTC in most containers) would roll the "day" over at 5:30 AM
// Colombo, silently resetting streaks and daily quests. Format every instant in
// Asia/Colombo so day boundaries always land at local midnight.
const colomboParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Colombo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function dayKey(date: Date): string {
  const parts = colomboParts.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Civil-day arithmetic on a "YYYY-MM-DD" key. Steps through a UTC container so
// it never depends on the server's timezone (Sri Lanka has no DST, so a calendar
// day is exactly 24h and this stays aligned with the Colombo keys above).
function addDays(key: string, n: number): string {
  const [y, mo, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

const colomboWeekday = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Colombo",
  weekday: "short",
});

export function computeMetrics(
  orders: Order[],
  manifests: ShippingManifest[],
  settings: BusinessSettings,
  products: Product[] = [],
  events: TrackingEvent[] = []
): Metrics {
  const delivered = orders.filter((o) => o.order_status === "delivered").length;
  const totalPackages = orders.filter((o) => o.order_status !== "pending").length;
  const cashInFlight = orders
    .filter((o) => o.order_status === "booked")
    .reduce((sum, o) => sum + Number(o.total_cod), 0);

  // Level: index of the first threshold not yet reached.
  let level = 1;
  let levelBase = 0;
  let levelTarget = LEVELS[0];
  for (let i = 0; i < LEVELS.length; i++) {
    if (delivered >= LEVELS[i]) {
      level = i + 2;
      levelBase = LEVELS[i];
      levelTarget = LEVELS[i + 1] ?? LEVELS[i];
    }
  }
  const span = Math.max(levelTarget - levelBase, 1);
  const levelProgressPct = Math.min(100, Math.round(((delivered - levelBase) / span) * 100));

  // Per-day shipment counts (local calendar days).
  const perDay = new Map<string, number>();
  for (const m of manifests) {
    const key = dayKey(new Date(m.created_at));
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  const today = dayKey(new Date());
  const shippedToday = perDay.get(today) ?? 0;

  // Dispatch streak: consecutive calendar days with ≥1 booking, ending today or yesterday.
  let streak = 0;
  let cursor = perDay.has(today) ? today : addDays(today, -1); // today hasn't broken the streak yet
  while (perDay.has(cursor)) {
    streak++;
    cursor = addDays(cursor, -1);
  }
  const streakAtRisk = streak > 0 && shippedToday === 0;

  // Longest streak ever: walk each streak-start day forward.
  let bestStreak = streak;
  for (const key of perDay.keys()) {
    if (perDay.has(addDays(key, -1))) continue; // not a streak start
    let len = 0;
    let walk = key;
    while (perDay.has(walk)) {
      len++;
      walk = addDays(walk, 1);
    }
    if (len > bestStreak) bestStreak = len;
  }

  // Best day ever, and best day BEFORE today (a stable target to beat today).
  let bestDay = 0;
  let bestDayBefore = 0;
  for (const [key, count] of perDay) {
    if (count > bestDay) bestDay = count;
    if (key !== today && count > bestDayBefore) bestDayBefore = count;
  }

  // Adaptive daily goal: ~25% above the last 7 days' average (excluding today,
  // so shipping more never moves today's goalposts). Floor 2, cap 15.
  let last7 = 0;
  let w = today;
  for (let i = 1; i <= 7; i++) {
    w = addDays(w, -1);
    last7 += perDay.get(w) ?? 0;
  }
  const dailyGoal = Math.min(15, Math.max(2, Math.ceil((last7 / 7) * 1.25)));

  const quests: Quest[] = [
    {
      id: "daily-goal",
      emoji: "📦",
      label: `Ship ${dailyGoal} orders today`,
      progress: Math.min(shippedToday, dailyGoal),
      target: dailyGoal,
      done: shippedToday >= dailyGoal,
    },
    {
      id: "keep-flame",
      emoji: "🔥",
      label: streak > 0 ? `Keep the ${streak}-day flame alive` : "Light the flame — ship 1 order",
      progress: Math.min(shippedToday, 1),
      target: 1,
      done: shippedToday >= 1,
    },
    {
      id: "beat-record",
      emoji: "🏅",
      label: `Beat your best day (${bestDayBefore})`,
      progress: Math.min(shippedToday, Math.max(bestDayBefore + 1, 2)),
      target: Math.max(bestDayBefore + 1, 2),
      done: shippedToday >= Math.max(bestDayBefore + 1, 2),
    },
  ];

  const productStockValue = products.reduce((sum, p) => sum + p.stock_units * p.unit_cost, 0);
  const stockValue = settings.stock_units * settings.stock_unit_cost + productStockValue;
  const stockUnits =
    settings.stock_units + products.reduce((sum, p) => sum + p.stock_units, 0);
  const netWorth = settings.bank_cash + stockValue + cashInFlight;

  const badges: Badge[] = [
    { id: "first-flight", emoji: "🐣", name: "First Flight", desc: "Dispatch your first package", earned: totalPackages >= 1 },
    { id: "ten-pack", emoji: "📦", name: "Ten Pack", desc: "Dispatch 10 packages", earned: totalPackages >= 10 },
    { id: "road-warrior", emoji: "🚚", name: "Road Warrior", desc: "Dispatch 50 packages", earned: totalPackages >= 50 },
    { id: "century-club", emoji: "💯", name: "Century Club", desc: "Dispatch 100 packages", earned: totalPackages >= 100 },
    { id: "warehouse-boss", emoji: "🏭", name: "Warehouse Boss", desc: "Dispatch 250 packages", earned: totalPackages >= 250 },
    { id: "money-in", emoji: "✅", name: "Money In", desc: "First delivered order", earned: delivered >= 1 },
    { id: "warmed-up", emoji: "🔥", name: "Warmed Up", desc: "3-day dispatch streak", earned: bestStreak >= 3 },
    { id: "week-of-fire", emoji: "⚡", name: "Week of Fire", desc: "7-day dispatch streak", earned: bestStreak >= 7 },
    { id: "unstoppable", emoji: "🌋", name: "Unstoppable", desc: "14-day dispatch streak", earned: bestStreak >= 14 },
    { id: "habit-royalty", emoji: "👑", name: "Habit Royalty", desc: "30-day dispatch streak", earned: bestStreak >= 30 },
    { id: "big-day", emoji: "🌟", name: "Big Day", desc: "5 packages in one day", earned: bestDay >= 5 },
    { id: "mega-day", emoji: "🚀", name: "Mega Day", desc: "10 packages in one day", earned: bestDay >= 10 },
    { id: "lakh-club", emoji: "💰", name: "Lakh Club", desc: "Net worth over Rs. 100,000", earned: netWorth >= 100_000 },
    { id: "millionaire", emoji: "💎", name: "Millionaire", desc: "Net worth over Rs. 1,000,000", earned: netWorth >= 1_000_000 },
  ];

  // Last-14-day activity series. Dispatches come from manifests (perDay is
  // already bucketed); delivered/returned days come from the tracking timeline,
  // which is the only place a delivery date is recorded.
  const deliveredPerDay = new Map<string, number>();
  const returnedPerDay = new Map<string, number>();
  for (const e of events) {
    if (e.outcome !== "delivered" && e.outcome !== "returned") continue;
    const bucket = e.outcome === "delivered" ? deliveredPerDay : returnedPerDay;
    const key = dayKey(new Date(e.created_at));
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
  }
  const days: DayStat[] = [];
  for (let i = 13; i >= 0; i--) {
    const key = addDays(today, -i);
    const [y, mo, d] = key.split("-").map(Number);
    // Noon UTC on that civil date is unambiguously the same date in Colombo.
    const label = colomboWeekday.format(new Date(Date.UTC(y, mo - 1, d, 12)));
    days.push({
      key,
      label,
      dispatched: perDay.get(key) ?? 0,
      delivered: deliveredPerDay.get(key) ?? 0,
      returned: returnedPerDay.get(key) ?? 0,
    });
  }

  return {
    level,
    levelTarget,
    levelBase,
    delivered,
    levelProgressPct,
    totalPackages,
    dispatchStreakDays: streak,
    bestStreakDays: bestStreak,
    streakAtRisk,
    shippedToday,
    dailyGoal,
    bestDay,
    cashInFlight,
    stockUnits,
    netWorth,
    netWorthBreakdown: {
      bankCash: settings.bank_cash,
      stockValue,
      pendingRemittances: cashInFlight,
    },
    quests,
    badges,
    days,
  };
}
