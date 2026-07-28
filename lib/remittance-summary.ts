import type { CourierRemittance } from "./types";

export interface RemittanceSummary {
  total_paid_to_me: number;
  paid_this_month: number;
  total_invoice_expected: number;
  total_gross_cod: number;
  courier_costs_and_deductions: number;
  total_variance: number;
  settlement_count: number;
  last_payout: { amount: number; paid_at: string; invoice_no: string } | null;
  month_label: string;
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;

function colomboMonthParts(date: Date): { year: string; month: string; label: string } {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const label = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Colombo",
    month: "long",
    year: "numeric",
  }).format(date);
  return { year, month, label };
}

export function summarizeRemittances(
  remittances: CourierRemittance[],
  now = new Date()
): RemittanceSummary {
  const current = colomboMonthParts(now);
  const sorted = [...remittances].sort((a, b) => b.paid_at.localeCompare(a.paid_at));
  const isCurrentMonth = (paidAt: string) => {
    const parts = colomboMonthParts(new Date(paidAt));
    return parts.year === current.year && parts.month === current.month;
  };
  const sum = (pick: (batch: CourierRemittance) => number, rows = remittances) =>
    roundMoney(rows.reduce((total, batch) => total + Number(pick(batch) || 0), 0));

  return {
    total_paid_to_me: sum((batch) => batch.amount_received),
    paid_this_month: sum(
      (batch) => batch.amount_received,
      remittances.filter((batch) => isCurrentMonth(batch.paid_at))
    ),
    total_invoice_expected: sum((batch) => batch.invoice_payable),
    total_gross_cod: sum((batch) => batch.gross_cod),
    courier_costs_and_deductions: sum(
      (batch) =>
        Number(batch.delivery_charges || 0) +
        Number(batch.commission || 0) +
        Number(batch.invoice_vat || 0) +
        Number(batch.additional_tax || 0) +
        Number(batch.other_deductions || 0)
    ),
    total_variance: sum((batch) => batch.variance),
    settlement_count: remittances.length,
    last_payout: sorted[0]
      ? {
          amount: Number(sorted[0].amount_received || 0),
          paid_at: sorted[0].paid_at,
          invoice_no: sorted[0].invoice_no,
        }
      : null,
    month_label: current.label,
  };
}
