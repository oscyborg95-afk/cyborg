import type {
  AdSpend,
  BusinessSettings,
  Order,
  Product,
  ShippingManifest,
  TrackingEvent,
} from "./types";
import { courierCostFor } from "./districts";
import { phoneKey } from "./risk";

// Level thresholds by cumulative SHIPPED orders (anything handed to a courier).
// Level N is complete at LEVELS[N]. Progress moves the moment you book an order,
// not days later when it's delivered.
export const LEVELS = [10, 50, 150, 400, 1000, 2500, 6000, 15000];

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
// Count-based badges carry progress/target so the locked tile can show how
// close the next unlock is.
export interface Badge {
  id: string;
  emoji: string;
  name: string;
  desc: string;
  earned: boolean;
  progress?: number;
  target?: number;
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

// One calendar month of business history — the growth report's row.
export interface MonthStat {
  key: string; // "YYYY-MM" in Asia/Colombo
  label: string; // "Feb ’26"
  shipped: number; // parcels handed to a courier that month
  delivered: number;
  returned: number;
  revenue: number; // delivered COD that month
  netProfit: number; // revenue − COGS − courier fees − ad spend
  marginPct: number;
  aov: number; // average delivered order value
}

// One repeat-worthy customer: everything they've actually paid for.
export interface TopCustomer {
  name: string;
  phone: string;
  orders: number; // delivered orders
  revenue: number; // delivered COD
}

// Who keeps coming back. Repeat buyers are the cheapest revenue a COD shop
// has — no ad spend, and they already proved they open the door.
export interface CustomerInsights {
  buyers: number; // unique phones with ≥1 delivered order
  repeatBuyers: number; // ≥2 delivered orders
  repeatRatePct: number; // repeatBuyers / buyers
  totalRevenue: number; // lifetime delivered COD
  repeatRevenue: number; // lifetime delivered COD from repeat buyers
  repeatRevenuePct: number;
  topCustomers: TopCustomer[]; // best 5 by delivered revenue
}

// How long parcels ride: dispatch day → delivered day, in civil days.
export interface SpeedStat {
  name: string; // district
  avgDays: number;
  count: number; // parcels measured
}

export interface DeliverySpeed {
  avgDays: number | null; // null until one parcel completes the trip
  measured: number; // parcels with both a dispatch and a delivered date
  byDistrict: SpeedStat[]; // slowest first
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
  // --- Decision reports ------------------------------------------------------
  months: MonthStat[]; // last 6 calendar months, oldest first
  customers: CustomerInsights;
  speed: DeliverySpeed;
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

  // Badges are assembled at the bottom of this function — the fun ones need
  // the report aggregations (months, customers, districts) computed below.

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

  // --- Monthly trend report ---------------------------------------------------
  // Same accounting as the P&L (revenue/costs on the settlement day, shipped on
  // the manifest day), bucketed per calendar month over ALL history. The full
  // series also answers "was there ever a profitable month?" for its badge.
  interface MonthAgg {
    shipped: number;
    delivered: number;
    returned: number;
    revenue: number;
    cogs: number;
    courier: number;
    ad: number;
  }
  const monthAgg = new Map<string, MonthAgg>();
  const monthOf = (day: string) => day.slice(0, 7);
  const bucketFor = (month: string): MonthAgg => {
    let m = monthAgg.get(month);
    if (!m) {
      m = { shipped: 0, delivered: 0, returned: 0, revenue: 0, cogs: 0, courier: 0, ad: 0 };
      monthAgg.set(month, m);
    }
    return m;
  };
  for (const [day, count] of perDay) bucketFor(monthOf(day)).shipped += count;
  for (const [orderId, day] of deliveredDayByOrder) {
    const o = orderById.get(orderId);
    if (!o) continue;
    const m = bucketFor(monthOf(day));
    m.delivered++;
    m.revenue += Number(o.total_cod);
    m.cogs += orderCogs(o);
    m.courier += courierCostFor(o.district, settings.courier_cost_base, settings.courier_cost_overrides);
  }
  for (const [orderId, day] of returnedDayByOrder) {
    if (!orderById.has(orderId)) continue;
    const m = bucketFor(monthOf(day));
    m.returned++;
    m.courier += Number(settings.courier_return_cost);
  }
  for (const s of adSpend) bucketFor(monthOf(s.day)).ad += Number(s.amount);

  const monthLabel = (key: string): string => {
    const [y, mo] = key.split("-").map(Number);
    const short = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Colombo",
      month: "short",
    }).format(new Date(Date.UTC(y, mo - 1, 15)));
    return `${short} ’${String(y).slice(2)}`;
  };
  const allMonths: MonthStat[] = [...monthAgg.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, m]) => {
      const netProfit = m.revenue - m.cogs - m.courier - m.ad;
      return {
        key,
        label: monthLabel(key),
        shipped: m.shipped,
        delivered: m.delivered,
        returned: m.returned,
        revenue: m.revenue,
        netProfit,
        marginPct: m.revenue > 0 ? Math.round((netProfit / m.revenue) * 100) : 0,
        aov: m.delivered > 0 ? Math.round(m.revenue / m.delivered) : 0,
      };
    });
  const months = allMonths.slice(-6);
  const everProfitableMonth = allMonths.some((m) => m.revenue > 0 && m.netProfit > 0);

  // --- Customer insights --------------------------------------------------------
  // Group by the last-9-digits phone identity (same trick risk scoring uses).
  // A "buyer" actually took delivery at least once; a repeat buyer did it twice.
  const custAgg = new Map<
    string,
    { name: string; phone: string; latest: string; delivered: number; revenue: number }
  >();
  for (const o of orders) {
    const key = phoneKey(o.phone_number);
    if (key.length < 9) continue;
    let c = custAgg.get(key);
    if (!c) {
      c = { name: o.customer_name, phone: o.phone_number, latest: o.created_at, delivered: 0, revenue: 0 };
      custAgg.set(key, c);
    }
    if (o.created_at >= c.latest) {
      c.latest = o.created_at;
      if (o.customer_name) c.name = o.customer_name;
      c.phone = o.phone_number;
    }
    if (o.order_status === "delivered") {
      c.delivered++;
      c.revenue += Number(o.total_cod);
    }
  }
  let buyers = 0;
  let repeatBuyers = 0;
  let totalRevenue = 0;
  let repeatRevenue = 0;
  for (const c of custAgg.values()) {
    if (c.delivered === 0) continue;
    buyers++;
    totalRevenue += c.revenue;
    if (c.delivered >= 2) {
      repeatBuyers++;
      repeatRevenue += c.revenue;
    }
  }
  const topCustomers: TopCustomer[] = [...custAgg.values()]
    .filter((c) => c.delivered > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map((c) => ({ name: c.name || c.phone, phone: c.phone, orders: c.delivered, revenue: c.revenue }));
  const customers: CustomerInsights = {
    buyers,
    repeatBuyers,
    repeatRatePct: buyers > 0 ? Math.round((repeatBuyers / buyers) * 100) : 0,
    totalRevenue,
    repeatRevenue,
    repeatRevenuePct: totalRevenue > 0 ? Math.round((repeatRevenue / totalRevenue) * 100) : 0,
    topCustomers,
  };

  // --- Delivery speed -----------------------------------------------------------
  // Dispatch day (earliest manifest) → delivered day, in civil days. Rides
  // longer than 60 days are treated as data glitches and skipped.
  const dispatchDayByOrder = new Map<string, string>();
  for (const m of manifests) {
    const key = dayKey(new Date(m.created_at));
    const prev = dispatchDayByOrder.get(m.order_id);
    if (!prev || key < prev) dispatchDayByOrder.set(m.order_id, key);
  }
  const civilDiff = (a: string, b: string): number => {
    const [ay, am, ad] = a.split("-").map(Number);
    const [by, bm, bd] = b.split("-").map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
  };
  let speedSum = 0;
  let speedCount = 0;
  const speedByDistrict = new Map<string, { sum: number; count: number }>();
  for (const [orderId, deliveredDay] of deliveredDayByOrder) {
    const dispatchDay = dispatchDayByOrder.get(orderId);
    const o = orderById.get(orderId);
    if (!dispatchDay || !o) continue;
    const days = civilDiff(dispatchDay, deliveredDay);
    if (days < 0 || days > 60) continue;
    speedSum += days;
    speedCount++;
    const district = o.district || "Unknown";
    const agg = speedByDistrict.get(district) ?? { sum: 0, count: 0 };
    agg.sum += days;
    agg.count++;
    speedByDistrict.set(district, agg);
  }
  const speed: DeliverySpeed = {
    avgDays: speedCount > 0 ? Math.round((speedSum / speedCount) * 10) / 10 : null,
    measured: speedCount,
    byDistrict: [...speedByDistrict.entries()]
      .map(([name, { sum, count }]) => ({
        name,
        avgDays: Math.round((sum / count) * 10) / 10,
        count,
      }))
      .sort((a, b) => b.avgDays - a.avgDays),
  };

  // --- Badge cabinet --------------------------------------------------------------
  // Every ingredient below is a lifetime record (never decreases), so a badge
  // can never un-earn. Count badges carry progress/target for the locked tiles.

  // Longest run of consecutive deliveries with zero returns, in settlement order.
  const settled: { day: string; returned: boolean }[] = [];
  for (const o of orders) {
    if (o.order_status !== "delivered" && o.order_status !== "returned") continue;
    const isReturn = o.order_status === "returned";
    const day =
      (isReturn ? returnedDayByOrder.get(o.id) : deliveredDayByOrder.get(o.id)) ??
      dayKey(new Date(o.created_at));
    settled.push({ day, returned: isReturn });
  }
  settled.sort((a, b) => (a.day < b.day ? -1 : 1));
  let cleanRun = 0;
  let bestCleanRun = 0;
  for (const s of settled) {
    cleanRun = s.returned ? 0 : cleanRun + 1;
    if (cleanRun > bestCleanRun) bestCleanRun = cleanRun;
  }

  // Time-of-day and weekend records from manifest timestamps.
  const colomboHour = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Colombo",
    hour: "numeric",
    hour12: false,
  });
  let earlyBird = false;
  let nightOwl = false;
  for (const m of manifests) {
    const h = Number(colomboHour.format(new Date(m.created_at))) % 24;
    if (h < 9) earlyBird = true;
    if (h >= 21) nightOwl = true;
  }
  let shippedSat = false;
  let shippedSun = false;
  for (const key of perDay.keys()) {
    const [y, mo, d] = key.split("-").map(Number);
    const wd = colomboWeekday.format(new Date(Date.UTC(y, mo - 1, d, 12)));
    if (wd === "Sat") shippedSat = true;
    if (wd === "Sun") shippedSun = true;
  }

  // Island coverage: distinct districts ever shipped to (out of 25).
  const districtsShipped = new Set(
    orders
      .filter((o) => o.order_status !== "pending" && o.district && o.district !== "Unknown")
      .map((o) => o.district)
  ).size;

  const lifetimeRevenue = totalRevenue;

  const countBadge = (
    id: string,
    emoji: string,
    name: string,
    desc: string,
    value: number,
    target: number
  ): Badge => ({
    id,
    emoji,
    name,
    desc,
    earned: value >= target,
    progress: Math.min(Math.round(value), target),
    target,
  });

  const badges: Badge[] = [
    // Dispatch volume
    countBadge("first-flight", "🐣", "First Flight", "Dispatch your first package", totalPackages, 1),
    countBadge("ten-pack", "📦", "Ten Pack", "Dispatch 10 packages", totalPackages, 10),
    countBadge("road-warrior", "🚚", "Road Warrior", "Dispatch 50 packages", totalPackages, 50),
    countBadge("century-club", "💯", "Century Club", "Dispatch 100 packages", totalPackages, 100),
    countBadge("warehouse-boss", "🏭", "Warehouse Boss", "Dispatch 250 packages", totalPackages, 250),
    countBadge("convoy-commander", "🚛", "Convoy Commander", "Dispatch 500 packages", totalPackages, 500),
    countBadge("thousand-club", "🐉", "Thousand Club", "Dispatch 1,000 packages", totalPackages, 1000),
    // Deliveries landed
    countBadge("money-in", "✅", "Money In", "First delivered order", delivered, 1),
    countBadge("ten-landed", "📬", "Ten Landed", "10 orders delivered", delivered, 10),
    countBadge("fifty-landed", "🎯", "Sharp Shooter", "50 orders delivered", delivered, 50),
    countBadge("delivery-century", "🏆", "Delivery Century", "100 orders delivered", delivered, 100),
    countBadge("half-k-landed", "🌠", "Half-K Landed", "500 orders delivered", delivered, 500),
    // Streaks
    countBadge("warmed-up", "🔥", "Warmed Up", "3-day dispatch streak", bestStreak, 3),
    countBadge("week-of-fire", "⚡", "Week of Fire", "7-day dispatch streak", bestStreak, 7),
    countBadge("unstoppable", "🌋", "Unstoppable", "14-day dispatch streak", bestStreak, 14),
    countBadge("habit-royalty", "👑", "Habit Royalty", "30-day dispatch streak", bestStreak, 30),
    countBadge("diamond-streak", "💠", "Diamond Streak", "60-day dispatch streak", bestStreak, 60),
    countBadge("eternal-flame", "🌞", "Eternal Flame", "100-day dispatch streak", bestStreak, 100),
    // Single-day records
    countBadge("big-day", "🌟", "Big Day", "5 packages in one day", bestDay, 5),
    countBadge("mega-day", "🚀", "Mega Day", "10 packages in one day", bestDay, 10),
    countBadge("beast-mode", "💪", "Beast Mode", "15 packages in one day", bestDay, 15),
    countBadge("warehouse-inferno", "🧨", "Warehouse Inferno", "20 packages in one day", bestDay, 20),
    // Net worth
    countBadge("lakh-club", "💰", "Lakh Club", "Net worth over Rs. 100,000", netWorth, 100_000),
    countBadge("half-million", "🪙", "Half-Million", "Net worth over Rs. 500,000", netWorth, 500_000),
    countBadge("millionaire", "💎", "Millionaire", "Net worth over Rs. 1,000,000", netWorth, 1_000_000),
    countBadge("tycoon", "🏰", "Tycoon", "Net worth over Rs. 5,000,000", netWorth, 5_000_000),
    // Lifetime delivered revenue
    countBadge("first-lakh-sold", "💵", "First Lakh Sold", "Rs. 100,000 delivered lifetime", lifetimeRevenue, 100_000),
    countBadge("money-machine", "💸", "Money Machine", "Rs. 1,000,000 delivered lifetime", lifetimeRevenue, 1_000_000),
    countBadge("rupee-rocket", "🛸", "Rupee Rocket", "Rs. 10,000,000 delivered lifetime", lifetimeRevenue, 10_000_000),
    // Profitability
    {
      id: "green-month",
      emoji: "🌱",
      name: "Green Month",
      desc: "Finish a calendar month in profit",
      earned: everProfitableMonth,
    },
    // Repeat customers
    countBadge("first-fan", "🤝", "First Fan", "One customer ordered twice", repeatBuyers, 1),
    countBadge("fan-club", "🫶", "Fan Club", "10 repeat customers", repeatBuyers, 10),
    countBadge("cult-following", "🧲", "Cult Following", "25 repeat customers", repeatBuyers, 25),
    // Island coverage
    countBadge("island-explorer", "🗺️", "Island Explorer", "Ship to 10 districts", districtsShipped, 10),
    countBadge("all-island-legend", "🏝️", "All-Island Legend", "Ship to all 25 districts", districtsShipped, 25),
    // Perfect runs
    countBadge("safe-hands", "🧤", "Safe Hands", "10 deliveries in a row, zero returns", bestCleanRun, 10),
    countBadge("iron-wall", "🛡️", "Iron Wall", "30 deliveries in a row, zero returns", bestCleanRun, 30),
    // Time-of-day flair
    { id: "early-bird", emoji: "🌅", name: "Early Bird", desc: "Dispatch before 9 AM", earned: earlyBird },
    { id: "night-owl", emoji: "🦉", name: "Night Owl", desc: "Dispatch after 9 PM", earned: nightOwl },
    {
      id: "weekend-warrior",
      emoji: "🏖️",
      name: "Weekend Warrior",
      desc: "Dispatch on a Saturday and a Sunday",
      earned: shippedSat && shippedSun,
    },
  ];

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
    months,
    customers,
    speed,
  };
}
