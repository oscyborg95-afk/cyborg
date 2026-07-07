import type { Order } from "./types";

// COD risk scoring from the customer's own order history.
//
// Returns kill the margin in a COD business: the parcel rides to the door and
// comes back at your cost. Before booking, look the phone number up in past
// orders and surface what happened last time.

export type RiskTier = "new" | "good" | "watch" | "risky";

export interface CustomerRisk {
  tier: RiskTier;
  delivered: number;
  returned: number;
  inFlight: number; // booked, still riding
  pending: number;
  emoji: string;
  label: string;
  hint: string;
}

// Sri Lankan numbers appear as 0771234567, 771234567, or 94771234567 depending
// on where they were typed. The last 9 digits are the stable identity.
function phoneKey(phone: string): string {
  return phone.replace(/\D/g, "").slice(-9);
}

export function customerRisk(orders: Order[], phone: string): CustomerRisk {
  const key = phoneKey(phone);
  let delivered = 0;
  let returned = 0;
  let inFlight = 0;
  let pending = 0;
  if (key.length >= 9) {
    for (const o of orders) {
      if (phoneKey(o.phone_number) !== key && phoneKey(o.phone_2) !== key) continue;
      if (o.order_status === "delivered") delivered++;
      else if (o.order_status === "returned") returned++;
      else if (o.order_status === "booked") inFlight++;
      else pending++;
    }
  }

  let tier: RiskTier;
  if (returned > 0 && returned >= delivered) tier = "risky";
  else if (returned > 0) tier = "watch";
  else if (delivered > 0) tier = "good";
  else tier = "new";

  const meta: Record<RiskTier, { emoji: string; label: string; hint: string }> = {
    risky: {
      emoji: "🔴",
      label: `Risky — ${returned} returned, ${delivered} delivered`,
      hint: "Call to verify before booking, or ask for an advance.",
    },
    watch: {
      emoji: "🟡",
      label: `Mixed — ${delivered} delivered, ${returned} returned`,
      hint: "Has taken delivery before, but also refused once. Confirm clearly.",
    },
    good: {
      emoji: "🟢",
      label: `Repeat buyer — ${delivered} delivered${returned ? `, ${returned} returned` : ""}`,
      hint: "Took delivery before. Safe to book.",
    },
    new: {
      emoji: "🆕",
      label: "New customer — no history",
      hint: "First order from this number.",
    },
  };

  return { tier, delivered, returned, inFlight, pending, ...meta[tier] };
}
