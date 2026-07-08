import type {
  AdSpend,
  BusinessSettings,
  Order,
  Product,
  ShippingManifest,
  TrackingEvent,
} from "./types";
import { courierCostFor } from "./districts";

// Level thresholds by cumulative SHIPPED orders (anything handed to a courier).
// Level N is complete at LEVELS[N]. Progress moves the moment you book an order,
// not days later when it's delivered.
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

// Delivery outcomes bucketed by district or by product line — surfaces where
// COD returns are eating the margin.
export interface OutcomeStat {
  name: string;
  shipped: number; // completed journeys: delivered + returned
  delivered: number;
  returned: number;
  returnRatePct: number;
}

// Ad spend vs. delivered COD revenue over a trailing window.
export interface AdWindow {
  spend: number;
  revenue: number; // COD value of orders DELIVERED in the window
  deliveredCount: number;
}

// A real profit-and-loss waterfall for one window. Revenue is delivered COD
// (money that actually became real); every cost that ate into it is subtracted
// to land on net profit — the number the net-worth counter can't show you.
export interface PnlWindow {
  label: string; // "This month" / "Last 7 days"
  revenue: number; // delivered COD in the window
  cogs: number; // product unit cost × qty on delivered orders
  courierCost: number; // courier fees on delivered + returned parcels
  adSpend: number; // ad spend logged in the window
  netProfit: number; // revenue − cogs − courierCost − adSpend
  marginPct: number; // netProfit / revenue (0 when no revenue)
  deliveredCount: number;
  returnedCount: number;
}

// The bleed a return-rate chart only hints at, priced in rupees: every returned
// parcel this month cost the courier's round-trip fee with nothing to show.
export interface ReturnLoss {
  monthCount: number;
  monthLoss: number;
}

// One product's runway: how many days of stock are left at the recent pace.
export interface ReorderItem {
  productId: string;
  name: string;
  stockUnits: number;
  perDay: number; // units shipped / day over the last 14 days
  coverDays: number | null; // stock ÷ perDay; null when nothing shipped lately
  urgent: boolean; // fewer than a week of cover left
}

// Where the money is right now: in hand, floating with couriers, or tied up in
// stock — plus what's realistically going to land once returns are netted out.
export interface CashFlow {
  collected: number; // bank cash in hand
  floating: number; // COD in flight + delivered-but-unremitted
  tiedInStock: number; // inventory value
  expectedLanding: number; // in-flight COD discounted by the blended return rate
  returnRatePct: number; // blended return rate used for the discount
}

export interface Metrics {
  level: number;
  levelTarget: number;
  levelBase: number;
  levelCount: number; // orders shipped so far — what the level is measured against
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
  awaitingPayout: number; // COD delivered but not yet remitted by the courier
  awaitingPayoutCount: number;
  stockUnits: number; // total physical units in the shed (products + legacy settings)
  netWorth: number;
  netWorthBreakdown: {
    bankCash: number;
    stockValue: number;
    cashInFlight: number;
    awaitingPayout: number;
  };
  quests: Quest[];
  badges: Badge[];
  days: DayStat[]; // last 14 Colombo days, oldest first — feeds the Quest chart
  districtStats: OutcomeStat[]; // sorted by volume, completed orders only
  productStats: OutcomeStat[];
  adPerf: { last7: AdWindow; last14: AdWindow };
  // --- Profit & cash-flow brain --------------------------------------------
  pnl: { month: PnlWindow; last7: PnlWindow };
  returnLoss: ReturnLoss;
  reorder: ReorderItem[]; // most urgent first
  cashFlow: CashFlow;
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
  events: TrackingEvent[] = [],
  adSpend: AdSpend[] = []
): Metrics {
  const delivered = orders.filter((o) => o.order_status === "delivered").length;
  const totalPackages = orders.filter((o) => o.order_status !== "pending").length;
  const cashInFlight = orders
    .filter((o) => o.order_status === "booked")
    .reduce((sum, o) => sum + Number(o.total_cod), 0);
  const awaitingPayoutOrders = orders.filter(
    (o) => o.order_status === "delivered" && !o.remitted_at
  );
  const awaitingPayout = awaitingPayoutOrders.reduce((sum, o) => sum + Number(o.total_cod), 0);

  // Level tracks shipped orders (everything handed to a courier), so it moves
  // as soon as you book — not days later when the courier marks it delivered.
  const levelCount = totalPackages;
  let level = 1;
  let levelBase = 0;
  let levelTarget = LEVELS[0];
  for (let i = 0; i < LEVELS.length; i++) {
    if (levelCount >= LEVELS[i]) {
      level = i + 2;
      levelBase = LEVELS[i];
      levelTarget = LEVELS[i + 1] ?? LEVELS[i];
    }
  }
  const span = Math.max(levelTarget - levelBase, 1);
  const levelProgressPct = Math.min(100, Math.round(((levelCount - levelBase) / span) * 100));

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
  // Delivered-but-unremitted COD is still the business's money — it sits with
  // the courier until the payout batch lands, so it counts toward net worth.
  const netWorth = settings.bank_cash + stockValue + cashInFlight + awaitingPayout;

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

  // --- Return-rate breakdowns (completed journeys only) ----------------------
  // A journey is "complete" once the courier settled it: delivered or returned.
  // Pending/booked orders are excluded so in-flight parcels don't dilute rates.
  const districtAgg = new Map<string, { delivered: number; returned: number }>();
  const productAgg = new Map<string, { delivered: number; returned: number }>();
  for (const o of orders) {
    if (o.order_status !== "delivered" && o.order_status !== "returned") continue;
    const isReturn = o.order_status === "returned";

    const district = o.district || "Unknown";
    const d = districtAgg.get(district) ?? { delivered: 0, returned: 0 };
    if (isReturn) d.returned++;
    else d.delivered++;
    districtAgg.set(district, d);

    // Bucket by line item when present, else the legacy single item name.
    const names =
      o.items && o.items.length > 0
        ? o.items.map((i) => i.name)
        : [o.item_name || "Unspecified item"];
    for (const name of new Set(names)) {
      const p = productAgg.get(name) ?? { delivered: 0, returned: 0 };
      if (isReturn) p.returned++;
      else p.delivered++;
      productAgg.set(name, p);
    }
  }
  const toStats = (agg: Map<string, { delivered: number; returned: number }>): OutcomeStat[] =>
    [...agg.entries()]
      .map(([name, { delivered: del, returned: ret }]) => ({
        name,
        shipped: del + ret,
        delivered: del,
        returned: ret,
        returnRatePct: Math.round((ret / Math.max(del + ret, 1)) * 100),
      }))
      .sort((a, b) => b.shipped - a.shipped);

  // --- Ad spend vs. delivered revenue (trailing 7/14 Colombo days) -----------
  // Revenue is attributed to the day the parcel was DELIVERED (first delivered
  // tracking event per order) — the day the cash actually became real.
  const codByOrder = new Map(orders.map((o) => [o.id, Number(o.total_cod)]));
  const deliveredDayByOrder = new Map<string, string>();
  for (const e of events) {
    if (e.outcome === "delivered" && !deliveredDayByOrder.has(e.order_id)) {
      deliveredDayByOrder.set(e.order_id, dayKey(new Date(e.created_at)));
    }
  }
  const windowStats = (daysBack: number): AdWindow => {
    const from = addDays(today, -(daysBack - 1)); // inclusive window ending today
    let spend = 0;
    for (const s of adSpend) {
      if (s.day >= from && s.day <= today) spend += Number(s.amount);
    }
    let revenue = 0;
    let deliveredCount = 0;
    for (const [orderId, day] of deliveredDayByOrder) {
      if (day >= from && day <= today) {
        revenue += codByOrder.get(orderId) ?? 0;
        deliveredCount++;
      }
    }
    return { spend, revenue, deliveredCount };
  };

  // --- Profit & cash-flow brain ----------------------------------------------
  // COGS uses each line's product unit cost; unlinked / legacy lines fall back
  // to the operator's declared generic unit cost so profit is never flattered
  // by a missing link.
  const unitCostById = new Map(products.map((p) => [p.id, Number(p.unit_cost)]));
  const costFallback = Number(settings.stock_unit_cost) || 0;
  const orderCogs = (o: Order): number => {
    const lines =
      o.items && o.items.length > 0
        ? o.items
        : [{ product_id: o.product_id, qty: 1, name: o.item_name, price: o.product_price }];
    return lines.reduce((sum, l) => {
      const unit = (l.product_id && unitCostById.get(l.product_id)) || costFallback;
      return sum + unit * (Number(l.qty) || 0);
    }, 0);
  };

  // Costs and revenue are booked on the day the parcel settled (delivered or
  // returned) — the same when-cash-becomes-real timing the ROAS card uses.
  const returnedDayByOrder = new Map<string, string>();
  for (const e of events) {
    if (e.outcome === "returned" && !returnedDayByOrder.has(e.order_id)) {
      returnedDayByOrder.set(e.order_id, dayKey(new Date(e.created_at)));
    }
  }
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const monthPrefix = today.slice(0, 7); // "YYYY-MM" in Colombo time
  const from7 = addDays(today, -6);
  const inMonth = (day: string) => day.slice(0, 7) === monthPrefix;
  const inLast7 = (day: string) => day >= from7 && day <= today;

  const pnlWindow = (label: string, inWindow: (day: string) => boolean): PnlWindow => {
    let revenue = 0;
    let cogs = 0;
    let courierCost = 0;
    let deliveredCount = 0;
    let returnedCount = 0;
    for (const [orderId, day] of deliveredDayByOrder) {
      if (!inWindow(day)) continue;
      const o = orderById.get(orderId);
      if (!o) continue;
      revenue += Number(o.total_cod);
      cogs += orderCogs(o);
      courierCost += courierCostFor(o.district, settings.courier_cost_base, settings.courier_cost_overrides);
      deliveredCount++;
    }
    for (const [orderId, day] of returnedDayByOrder) {
      if (!inWindow(day)) continue;
      if (!orderById.has(orderId)) continue;
      courierCost += Number(settings.courier_return_cost);
      returnedCount++;
    }
    let adSpendTotal = 0;
    for (const s of adSpend) {
      if (inWindow(s.day)) adSpendTotal += Number(s.amount);
    }
    const netProfit = revenue - cogs - courierCost - adSpendTotal;
    return {
      label,
      revenue,
      cogs,
      courierCost,
      adSpend: adSpendTotal,
      netProfit,
      marginPct: revenue > 0 ? Math.round((netProfit / revenue) * 100) : 0,
      deliveredCount,
      returnedCount,
    };
  };
  const pnl = {
    month: pnlWindow("This month", inMonth),
    last7: pnlWindow("Last 7 days", inLast7),
  };

  // Return loss this month — flat round-trip fee per parcel that came back.
  let monthReturnCount = 0;
  for (const [, day] of returnedDayByOrder) if (inMonth(day)) monthReturnCount++;
  const returnLoss: ReturnLoss = {
    monthCount: monthReturnCount,
    monthLoss: monthReturnCount * Number(settings.courier_return_cost),
  };

  // Reorder radar: units shipped per product over the last 14 days sets the pace;
  // current stock ÷ pace = days of cover left. Anything under a week is urgent.
  const shipped14 = new Map<string, number>();
  const since14 = addDays(today, -13);
  for (const o of orders) {
    if (o.order_status === "pending") continue;
    if (dayKey(new Date(o.created_at)) < since14) continue;
    const lines =
      o.items && o.items.length > 0
        ? o.items
        : o.product_id
          ? [{ product_id: o.product_id, qty: 1 }]
          : [];
    for (const l of lines) {
      if (!l.product_id) continue;
      shipped14.set(l.product_id, (shipped14.get(l.product_id) ?? 0) + (Number(l.qty) || 0));
    }
  }
  const reorder: ReorderItem[] = products
    .map((p) => {
      const perDay = (shipped14.get(p.id) ?? 0) / 14;
      const coverDays = perDay > 0 ? p.stock_units / perDay : null;
      return {
        productId: p.id,
        name: p.name,
        stockUnits: p.stock_units,
        perDay,
        coverDays,
        urgent: coverDays !== null && coverDays < 7,
      };
    })
    .filter((r) => r.perDay > 0 || r.stockUnits > 0)
    .sort((a, b) => {
      // Urgent (finite, low cover) first; idle-but-stocked products sink below.
      const av = a.coverDays ?? Infinity;
      const bv = b.coverDays ?? Infinity;
      return av - bv;
    });

  // Cash-flow snapshot. Expected landing discounts in-flight COD by the blended
  // return rate — the parcels riding right now won't all make it to the door.
  let completedDelivered = 0;
  let completedReturned = 0;
  for (const o of orders) {
    if (o.order_status === "delivered") completedDelivered++;
    else if (o.order_status === "returned") completedReturned++;
  }
  const blendedReturnRate =
    completedDelivered + completedReturned > 0
      ? completedReturned / (completedDelivered + completedReturned)
      : 0;
  const cashFlow: CashFlow = {
    collected: settings.bank_cash,
    floating: cashInFlight + awaitingPayout,
    tiedInStock: stockValue,
    expectedLanding: cashInFlight * (1 - blendedReturnRate),
    returnRatePct: Math.round(blendedReturnRate * 100),
  };

  return {
    level,
    levelTarget,
    levelBase,
    levelCount,
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
    awaitingPayout,
    awaitingPayoutCount: awaitingPayoutOrders.length,
    stockUnits,
    netWorth,
    netWorthBreakdown: {
      bankCash: settings.bank_cash,
      stockValue,
      cashInFlight,
      awaitingPayout,
    },
    quests,
    badges,
    days,
    districtStats: toStats(districtAgg),
    productStats: toStats(productAgg),
    adPerf: { last7: windowStats(7), last14: windowStats(14) },
    pnl,
    returnLoss,
    reorder,
    cashFlow,
  };
}
