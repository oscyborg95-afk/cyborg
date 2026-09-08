export const COLOMBO_TIME_ZONE = "Asia/Colombo";
export const DEFAULT_SERVICE_Z = 1.65;

export type ReplenishmentStatus =
  | "healthy"
  | "watch"
  | "order_now"
  | "already_ordered"
  | "no_demand_data"
  | "setup_needed";

export interface DemandDay {
  date: string;
  units: number;
}

export interface ClosureDay {
  date: string;
  name: string;
  source: "holiday" | "custom" | "weekday";
}

export interface ReplenishmentInput {
  productId: string;
  productName: string;
  currentStock: number;
  unitCost: number;
  demand: DemandDay[];
  now: Date;
  supplierConfigured: boolean;
  supplierId?: string | null;
  supplierName?: string | null;
  leadTimeWorkingDays?: number;
  workingWeekdays?: number[];
  closures?: ClosureDay[];
  serviceZ?: number;
  targetCoverDays?: number;
  moq?: number;
  packSize?: number;
  openInboundUnits?: number;
}

export interface ReplenishmentAnalysis {
  productId: string;
  productName: string;
  status: ReplenishmentStatus;
  confidence: "none" | "low" | "medium" | "high";
  currentStock: number;
  unitCost: number;
  baselineDailyRate: number;
  recentDailyRate: number;
  adjustedDailyRate: number;
  dailyVariability: number;
  trendPct: number;
  daysOfCover: number | null;
  exposureDays: number;
  safetyStock: number;
  reorderPoint: number;
  openInboundUnits: number;
  recommendedQuantity: number;
  estimatedPurchaseValue: number;
  expectedArrivalDate: string;
  skippedClosures: ClosureDay[];
  targetCoverDays: number;
  moq: number;
  packSize: number;
  supplierId: string | null;
  supplierName: string | null;
  demandSeries: DemandDay[];
  explanation: string;
}

const MS_DAY = 86_400_000;

export function civilDate(date: Date, timeZone = COLOMBO_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function utcDay(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function addCivilDays(date: string, days: number): string {
  return new Date(utcDay(date).getTime() + days * MS_DAY).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((utcDay(to).getTime() - utcDay(from).getTime()) / MS_DAY);
}

export function roundToPack(quantity: number, packSize = 1, moq = 1): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  const pack = Math.max(1, Math.floor(packSize));
  const minimum = Math.max(1, Math.ceil(moq));
  return Math.max(minimum, Math.ceil(quantity / pack) * pack);
}

export function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

export function normalizeDemand(days: DemandDay[], today: string, windowDays = 28): DemandDay[] {
  const totals = new Map<string, number>();
  for (const day of days) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isFinite(day.units) && day.units > 0) {
      totals.set(day.date, (totals.get(day.date) ?? 0) + day.units);
    }
  }
  return Array.from({ length: windowDays }, (_, index) => {
    const date = addCivilDays(today, index - windowDays + 1);
    return { date, units: totals.get(date) ?? 0 };
  });
}

export function demandPace(series: DemandDay[]): {
  baseline: number;
  recent: number;
  adjusted: number;
  variability: number;
  trendPct: number;
  confidence: ReplenishmentAnalysis["confidence"];
} {
  const values = series.map((day) => Math.max(0, day.units));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total === 0) return { baseline: 0, recent: 0, adjusted: 0, variability: 0, trendPct: 0, confidence: "none" };

  // Winsorise isolated spikes. Demand still reacts to acceleration, but one
  // viral day cannot trigger an operationally absurd supplier order.
  const sorted = [...values].sort((a, b) => a - b);
  const p75 = sorted[Math.floor((sorted.length - 1) * 0.75)] ?? 0;
  const cap = Math.max(3, p75 * 3);
  const stable = values.map((value) => Math.min(value, cap));
  const baseline = stable.reduce((sum, value) => sum + value, 0) / stable.length;
  const recentValues = stable.slice(-Math.min(7, stable.length));
  const recent = recentValues.reduce((sum, value) => sum + value, 0) / recentValues.length;
  const blended = baseline * 0.4 + recent * 0.6;
  const adjusted = Math.max(baseline, Math.min(blended, Math.max(baseline * 2.5, baseline + 1)));
  const activeDays = values.filter(Boolean).length;
  const confidence = activeDays >= 18 ? "high" : activeDays >= 8 ? "medium" : "low";
  return {
    baseline,
    recent,
    adjusted,
    variability: standardDeviation(stable),
    trendPct: baseline > 0 ? ((recent - baseline) / baseline) * 100 : 0,
    confidence,
  };
}

export function workingDayArrival(input: {
  startDate: string;
  leadTimeWorkingDays: number;
  workingWeekdays: number[];
  closures: ClosureDay[];
}): { arrivalDate: string; exposureDays: number; skipped: ClosureDay[] } {
  const allowed = new Set(input.workingWeekdays);
  const closures = new Map(input.closures.map((item) => [item.date, item]));
  const skipped: ClosureDay[] = [];
  let remaining = Math.max(1, Math.ceil(input.leadTimeWorkingDays));
  let cursor = input.startDate;
  let guard = 0;
  while (remaining > 0 && guard++ < 370) {
    cursor = addCivilDays(cursor, 1);
    const weekday = utcDay(cursor).getUTCDay();
    const closure = closures.get(cursor);
    if (!allowed.has(weekday)) {
      skipped.push({ date: cursor, name: weekday === 0 ? "Sunday courier closure" : "Courier non-working day", source: "weekday" });
      continue;
    }
    if (closure) {
      skipped.push(closure);
      continue;
    }
    remaining -= 1;
  }
  if (remaining > 0) throw new Error("No available courier delivery date within one year");
  return { arrivalDate: cursor, exposureDays: Math.max(1, daysBetween(input.startDate, cursor)), skipped };
}

export function analyzeReplenishment(input: ReplenishmentInput): ReplenishmentAnalysis {
  const today = civilDate(input.now);
  const series = normalizeDemand(input.demand, today, 28);
  const pace = demandPace(series);
  const leadTime = Math.max(1, Math.min(30, Math.ceil(input.leadTimeWorkingDays ?? 1)));
  const weekdays = input.workingWeekdays?.length ? input.workingWeekdays : [1, 2, 3, 4, 5, 6];
  const arrival = workingDayArrival({ startDate: today, leadTimeWorkingDays: leadTime, workingWeekdays: weekdays, closures: input.closures ?? [] });
  // A daily review interval is added to the physical lead time: if today's
  // review just misses a threshold, tomorrow morning is the next intervention.
  const exposureDays = arrival.exposureDays + 1;
  const z = Math.max(1, Math.min(2.58, input.serviceZ ?? DEFAULT_SERVICE_Z));
  const safetyStock = Math.ceil(z * pace.variability * Math.sqrt(exposureDays));
  const reorderPoint = Math.ceil(pace.adjusted * exposureDays + safetyStock);
  const inbound = Math.max(0, Math.floor(input.openInboundUnits ?? 0));
  const targetCoverDays = Math.max(1, Math.min(90, Math.ceil(input.targetCoverDays ?? 14)));
  const desiredStock = pace.adjusted * (exposureDays + targetCoverDays) + safetyStock;
  const shortage = Math.max(0, desiredStock - input.currentStock - inbound);
  const recommendedQuantity = roundToPack(shortage, input.packSize ?? 1, input.moq ?? 1);
  const daysOfCover = pace.adjusted > 0 ? input.currentStock / pace.adjusted : null;

  let status: ReplenishmentStatus;
  if (!input.supplierConfigured) status = "setup_needed";
  else if (pace.confidence === "none") status = "no_demand_data";
  // Inventory position is on-hand + inbound. "Already ordered" is only safe
  // when that inbound fully covers the target shortage; a partial shipment
  // must stay actionable so the operator can order the remaining quantity.
  else if (input.currentStock <= reorderPoint && inbound > 0 && recommendedQuantity === 0) status = "already_ordered";
  else if (input.currentStock <= reorderPoint) status = "order_now";
  else if (input.currentStock <= reorderPoint + pace.adjusted * 3) status = "watch";
  else status = "healthy";

  const closureText = arrival.skipped.length
    ? `${arrival.skipped.length} closure${arrival.skipped.length === 1 ? "" : "s"} skipped`
    : "no closures skipped";
  const explanation = `${Math.round(input.currentStock)} units on hand at ${pace.adjusted.toFixed(1)} units/day. `
    + `Arrival ${arrival.arrivalDate} (${closureText}); ${safetyStock} safety units protect a 95% service target. `
    + `${inbound} inbound units were subtracted. Target is ${targetCoverDays} days beyond arrival, rounded to packs of ${Math.max(1, input.packSize ?? 1)}${(input.moq ?? 1) > 1 ? ` with MOQ ${input.moq}` : ""}.`;

  return {
    productId: input.productId,
    productName: input.productName,
    status,
    confidence: pace.confidence,
    currentStock: input.currentStock,
    unitCost: input.unitCost,
    baselineDailyRate: pace.baseline,
    recentDailyRate: pace.recent,
    adjustedDailyRate: pace.adjusted,
    dailyVariability: pace.variability,
    trendPct: pace.trendPct,
    daysOfCover,
    exposureDays,
    safetyStock,
    reorderPoint,
    openInboundUnits: inbound,
    recommendedQuantity,
    estimatedPurchaseValue: recommendedQuantity * input.unitCost,
    expectedArrivalDate: arrival.arrivalDate,
    skippedClosures: arrival.skipped,
    targetCoverDays,
    moq: Math.max(1, input.moq ?? 1),
    packSize: Math.max(1, input.packSize ?? 1),
    supplierId: input.supplierId ?? null,
    supplierName: input.supplierName ?? null,
    demandSeries: series,
    explanation,
  };
}

export function automaticSendEligibility(analysis: ReplenishmentAnalysis): {
  eligible: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (analysis.status !== "order_now") reasons.push("Product is not currently at its reorder point");
  if (analysis.recommendedQuantity <= 0) reasons.push("No remaining shortage to order");
  if (!analysis.supplierId) reasons.push("No active preferred supplier is configured");
  if (!(["medium", "high"] as const).includes(analysis.confidence as "medium" | "high")) {
    reasons.push("Demand confidence is too low for an automatic business decision");
  }
  return { eligible: reasons.length === 0, reasons };
}

export interface PurchaseMessageInput {
  supplierName: string;
  businessName: string;
  reference: string;
  expectedDeliveryDate: string;
  lines: { name: string; quantity: number; supplierSku?: string | null }[];
}

export function renderPurchaseMessage(input: PurchaseMessageInput): string {
  const items = input.lines.map((line) => `• ${line.name}${line.supplierSku ? ` (${line.supplierSku})` : ""}: ${line.quantity} units`).join("\n");
  return `Hello ${input.supplierName},\n\n${input.businessName} would like to place purchase request ${input.reference}:\n${items}\n\nRequested delivery: ${input.expectedDeliveryDate}. Please confirm availability and delivery. Thank you.`;
}
