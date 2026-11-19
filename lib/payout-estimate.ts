// Estimate what the courier will actually deposit for delivered parcels that
// have not been settled yet. Gross COD overstates it by ~40%: Trans Express
// pays, per parcel, the COD it collected minus its delivery charge, minus a
// commission on the collected amount (and VAT on its fees, currently 0). Every
// input here is learned from invoices already imported, so the estimate
// tracks the courier's real tariff instead of a hand-typed one.

export interface OutstandingParcel {
  order_id: string;
  total_cod: number;
  city: string;
  district: string;
  /** When the courier reported the parcel delivered; null if never seen. */
  delivered_at: string | null;
  /** The courier's own status wording on that event, e.g. "Partially Delivered". */
  delivered_status: string;
  /** The courier's remark on that event ("Collected COD Rs. 1.00. …"). */
  delivered_remarks: string;
}

/** One distinct (place, charge) pair from imported invoices, with how often it occurred. */
export interface ChargeSample {
  city: string;
  district: string;
  delivery_charge: number;
  count: number;
}

/** The most recent imported invoice's totals, from which the rates are read. */
export interface LatestInvoiceTotals {
  collected_cod: number;
  commission: number;
  invoice_vat: number;
  delivery_charges: number;
}

export interface PayoutEstimateInput {
  parcels: OutstandingParcel[];
  charge_history: ChargeSample[];
  latest_invoice: LatestInvoiceTotals | null;
  /** paid_at of the most recently recorded settlement, if any. */
  last_paid_at: string | null;
  settings_base_charge: number;
  district_overrides: Partial<Record<string, number>>;
  now?: Date;
}

export interface PayoutBucket {
  count: number;
  gross_cod: number;
  collected_cod: number;
  delivery_charges: number;
  commission: number;
  vat: number;
  net: number;
}

export interface PartialParcel {
  order_id: string;
  total_cod: number;
  collected_cod: number;
  /** False when the courier gave no amount and 0 was assumed. */
  amount_known: boolean;
}

export interface PayoutEstimate {
  /** Parcels the next weekly invoice should cover (delivered up to its Thursday). */
  next: PayoutBucket & {
    /** Colombo date (YYYY-MM-DD) of the Thursday that closes this invoice. */
    period_end: string;
    /** That Thursday is over, so the invoice should already be available. */
    overdue: boolean;
  };
  /** Delivered after that Thursday: lands on the invoice after. */
  later: PayoutBucket;
  total: PayoutBucket;
  partial: PartialParcel[];
  prepaid_count: number;
  commission_rate: number;
  vat_rate: number;
  base_charge: number;
  /** How many past invoice lines the delivery charges were learned from. */
  learned_from_lines: number;
}

export const DEFAULT_COMMISSION_RATE = 0.01;
const CITY_MIN_SAMPLES = 2;
const DISTRICT_MIN_SAMPLES = 3;
const GLOBAL_MIN_SAMPLES = 10;
const COLOMBO_OFFSET_MS = 5.5 * 60 * 60 * 1000; // Sri Lanka has no DST
const DAY_MS = 24 * 60 * 60 * 1000;

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const placeKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

function emptyBucket(): PayoutBucket {
  return { count: 0, gross_cod: 0, collected_cod: 0, delivery_charges: 0, commission: 0, vat: 0, net: 0 };
}

/** The most frequent charge per key, among keys with enough samples. */
function modeByKey(
  samples: ChargeSample[],
  keyOf: (sample: ChargeSample) => string,
  minSamples: number
): Map<string, number> {
  const tallies = new Map<string, Map<number, number>>();
  for (const sample of samples) {
    const key = keyOf(sample);
    if (!key) continue;
    const tally = tallies.get(key) ?? new Map<number, number>();
    tally.set(sample.delivery_charge, (tally.get(sample.delivery_charge) ?? 0) + sample.count);
    tallies.set(key, tally);
  }
  const modes = new Map<string, number>();
  for (const [key, tally] of tallies) {
    let total = 0;
    let best: [number, number] | null = null;
    for (const [charge, count] of tally) {
      total += count;
      // Ties go to the cheaper charge: the higher one is usually a heavier one-off.
      if (!best || count > best[1] || (count === best[1] && charge < best[0])) best = [charge, count];
    }
    if (best && total >= minSamples) modes.set(key, best[0]);
  }
  return modes;
}

export interface DeliveryChargeModel {
  chargeFor(city: string, district: string): number;
  base: number;
  learnedFromLines: number;
}

export function learnDeliveryCharges(
  history: ChargeSample[],
  settingsBase: number,
  districtOverrides: Partial<Record<string, number>> = {}
): DeliveryChargeModel {
  const byCity = modeByKey(history, (s) => placeKey(s.city), CITY_MIN_SAMPLES);
  const byDistrict = modeByKey(history, (s) => placeKey(s.district), DISTRICT_MIN_SAMPLES);
  const global = modeByKey(history, () => "*", GLOBAL_MIN_SAMPLES).get("*");
  const overrides = new Map(
    Object.entries(districtOverrides).flatMap(([district, charge]) =>
      typeof charge === "number" && Number.isFinite(charge) ? [[placeKey(district), charge] as const] : []
    )
  );
  const base = global ?? settingsBase;
  return {
    base,
    learnedFromLines: history.reduce((total, sample) => total + sample.count, 0),
    chargeFor(city, district) {
      // What this exact city was actually charged beats everything; then the
      // owner's own district override; then the district's usual charge.
      return (
        byCity.get(placeKey(city)) ??
        overrides.get(placeKey(district)) ??
        byDistrict.get(placeKey(district)) ??
        base
      );
    },
  };
}

export function ratesFromInvoice(latest: LatestInvoiceTotals | null): { commission_rate: number; vat_rate: number } {
  if (!latest || !(Number(latest.collected_cod) > 0)) {
    return { commission_rate: DEFAULT_COMMISSION_RATE, vat_rate: 0 };
  }
  const commissionRate = Number(latest.commission) / Number(latest.collected_cod);
  const fees = Number(latest.delivery_charges) + Number(latest.commission);
  const vatRate = fees > 0 ? Number(latest.invoice_vat) / fees : 0;
  const clean = (rate: number) => (Number.isFinite(rate) && rate >= 0 && rate < 1 ? Math.round(rate * 1e6) / 1e6 : 0);
  return { commission_rate: clean(commissionRate), vat_rate: clean(vatRate) };
}

/** "Collected COD Rs. 1,240.00." → 1240. Null when the remark carries no amount. */
export function collectedAmountFromRemark(remark: string): number | null {
  const match = remark.match(/collected\s*cod\D{0,12}?([\d,]+(?:\.\d+)?)/i);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

const colomboDate = (instant: Date) => new Date(instant.getTime() + COLOMBO_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The Thursday that closes the next unrecorded weekly invoice. Each Trans
 * Express invoice covers Friday → Thursday, so after a settlement recorded on
 * day D the next one closes on the first Thursday after D.
 */
export function nextInvoicePeriodEnd(lastPaidAt: string | null, now: Date): { periodEnd: string; endsAt: Date } {
  const anchor = lastPaidAt ? new Date(new Date(lastPaidAt).getTime() + DAY_MS) : now;
  const anchorDay = new Date(`${colomboDate(anchor)}T00:00:00Z`);
  const daysToThursday = (4 - anchorDay.getUTCDay() + 7) % 7;
  const thursday = new Date(anchorDay.getTime() + daysToThursday * DAY_MS);
  const periodEnd = thursday.toISOString().slice(0, 10);
  // Exclusive end: Friday 00:00 in Colombo.
  const endsAt = new Date(thursday.getTime() + DAY_MS - COLOMBO_OFFSET_MS);
  return { periodEnd, endsAt };
}

function addToBucket(bucket: PayoutBucket, line: Omit<PayoutBucket, "count">) {
  bucket.count += 1;
  for (const key of ["gross_cod", "collected_cod", "delivery_charges", "commission", "vat", "net"] as const) {
    bucket[key] = roundMoney(bucket[key] + line[key]);
  }
}

export function estimatePayout(input: PayoutEstimateInput): PayoutEstimate {
  const now = input.now ?? new Date();
  const charges = learnDeliveryCharges(input.charge_history, input.settings_base_charge, input.district_overrides);
  const { commission_rate, vat_rate } = ratesFromInvoice(input.latest_invoice);
  const { periodEnd, endsAt } = nextInvoicePeriodEnd(input.last_paid_at, now);

  const next = emptyBucket();
  const later = emptyBucket();
  const total = emptyBucket();
  const partial: PartialParcel[] = [];
  let prepaidCount = 0;

  for (const parcel of input.parcels) {
    const grossCod = Math.max(0, Number(parcel.total_cod) || 0);
    let collected = grossCod;
    if (/partial/i.test(parcel.delivered_status)) {
      const reported = collectedAmountFromRemark(parcel.delivered_remarks);
      // With no amount on the event, assume nothing was collected: the courier
      // still charges delivery, and an under-estimate is the safer surprise.
      collected = Math.min(grossCod, reported ?? 0);
      partial.push({ order_id: parcel.order_id, total_cod: grossCod, collected_cod: collected, amount_known: reported !== null });
    }
    if (grossCod === 0) prepaidCount++;
    const delivery = charges.chargeFor(parcel.city, parcel.district);
    const commission = roundMoney(collected * commission_rate);
    const vat = roundMoney((delivery + commission) * vat_rate);
    const line = {
      gross_cod: grossCod,
      collected_cod: collected,
      delivery_charges: delivery,
      commission,
      vat,
      net: roundMoney(collected - delivery - commission - vat),
    };
    const deliveredAt = parcel.delivered_at ? new Date(parcel.delivered_at) : null;
    // A parcel with no delivered timestamp is an older one: it is already due.
    const onNext = !deliveredAt || Number.isNaN(deliveredAt.getTime()) || deliveredAt < endsAt;
    addToBucket(onNext ? next : later, line);
    addToBucket(total, line);
  }

  return {
    next: { ...next, period_end: periodEnd, overdue: now >= endsAt },
    later,
    total,
    partial,
    prepaid_count: prepaidCount,
    commission_rate,
    vat_rate,
    base_charge: charges.base,
    learned_from_lines: charges.learnedFromLines,
  };
}
