import type { Order, PaymentMethod } from "./types.ts";

// PaymentMethod is the field that used to be faked by zeroing a parcel with a
// full-amount discount — which made a bank transfer (real money received) and a
// replacement parcel (real loss) look identical, and booked both as Rs. 0
// revenue against full COGS.

export type { PaymentMethod };

export const PAYMENT_METHODS: PaymentMethod[] = ["cod", "bank_transfer", "replacement"];

export const PAYMENT_METHOD_META: Record<
  PaymentMethod,
  { label: string; short: string; emoji: string; hint: string; prepaid: boolean }
> = {
  cod: {
    label: "Cash on delivery",
    short: "COD",
    emoji: "💵",
    hint: "Courier collects the full amount.",
    prepaid: false, // the only method where money is still owed on delivery
  },
  bank_transfer: {
    label: "Bank transfer",
    short: "Bank",
    emoji: "🏦",
    hint: "Already paid to your account — courier collects nothing.",
    prepaid: true,
  },
  replacement: {
    label: "Replacement / re-send",
    short: "Replacement",
    emoji: "🔁",
    hint: "Fixing our own mistake — no revenue, cost only.",
    prepaid: true,
  },
};

// Legacy rows (and anything created before this field existed) are COD.
export function paymentMethodOf(order: { payment_method?: string | null }): PaymentMethod {
  const raw = order.payment_method;
  return raw === "bank_transfer" || raw === "replacement" ? raw : "cod";
}

export function isPrepaid(order: { payment_method?: string | null }): boolean {
  return paymentMethodOf(order) !== "cod";
}

// What the sale is worth, before deciding who pays it. Genuine discounts still
// reduce it; the payment method never does.
export function orderValue(order: {
  product_price: number | string;
  shipping_fee: number | string;
  discount: number | string;
}): number {
  return Math.max(
    0,
    Number(order.product_price) + Number(order.shipping_fee) - Number(order.discount)
  );
}

// What the courier is told to collect. Prepaid parcels ship at Rs. 0 exactly as
// the old full-discount hack made them, so courier booking is unaffected.
export function codToCollect(value: number, method: PaymentMethod): number {
  return method === "cod" ? Math.max(0, value) : 0;
}

// What the business actually earned. A replacement earns nothing (that is the
// point of it); a bank transfer earns the full order value even though the
// courier collected Rs. 0.
//
// COD deliberately reads the stored total_cod rather than recomputing, so every
// existing order's revenue stays bit-for-bit what it was before this field
// existed.
export function orderRevenue(order: Order): number {
  const method = paymentMethodOf(order);
  if (method === "replacement") return 0;
  if (method === "cod") return Number(order.total_cod) || 0;
  return orderValue(order);
}

// A returned prepaid parcel means we are holding the customer's money and owe
// them a refund — a liability a returned COD parcel never creates.
export function owesRefund(order: Order): boolean {
  return (
    order.order_status === "returned" &&
    paymentMethodOf(order) === "bank_transfer" &&
    orderValue(order) > 0
  );
}
