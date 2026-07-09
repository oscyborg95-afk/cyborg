import type { Order, OrderStatus } from "./types";

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
export function phoneKey(phone: string): string {
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

// --- Duplicate-order detection ----------------------------------------------
//
// A COD business ships the same parcel twice when a chat gets parsed into two
// orders, or a customer re-messages and a second order is raised — and both get
// booked. The tell: the SAME phone with another order raised close in time that
// hasn't come back. A *returned* parcel followed by a genuine re-order is NOT a
// duplicate, so returned orders are excluded from the match.

// How close in time two orders must be raised to look like the same order and
// not a legitimate repeat purchase days later.
export const DUP_WINDOW_HOURS = 72;

export interface DuplicateMatch {
  order: Order;
  sameItem: boolean; // same item signature → much stronger duplicate signal
  hoursApart: number;
  alreadyShipped: boolean; // the other order is booked/delivered — the real "shipped twice" case
}

// Only orders still in play can be duplicated; a returned parcel legitimately
// gets re-ordered, so it never counts as a duplicate of a later order.
function isActive(status: OrderStatus): boolean {
  return status !== "returned";
}

// Normalized item signature so "2x Cream" matches regardless of source shape
// (multi-line `items` vs the legacy single `item_name`).
function itemSignature(o: Order): string {
  if (o.items && o.items.length > 0) {
    return o.items
      .map((i) => `${i.name.toLowerCase().trim()}·${i.qty}`)
      .sort()
      .join("|");
  }
  return (o.item_name || "").toLowerCase().trim();
}

// Other orders for the same customer that look like accidental duplicates of
// `target`, closest in time first. Matches on either phone number.
export function findDuplicates(orders: Order[], target: Order): DuplicateMatch[] {
  const key = phoneKey(target.phone_number);
  if (key.length < 9 || !isActive(target.order_status)) return [];
  const targetTime = new Date(target.created_at).getTime();
  const matches: DuplicateMatch[] = [];
  for (const o of orders) {
    if (o.id === target.id || !isActive(o.order_status)) continue;
    if (phoneKey(o.phone_number) !== key && phoneKey(o.phone_2) !== key) continue;
    const hoursApart = Math.abs(targetTime - new Date(o.created_at).getTime()) / 3_600_000;
    if (hoursApart > DUP_WINDOW_HOURS) continue;
    matches.push({
      order: o,
      sameItem: itemSignature(o) === itemSignature(target),
      hoursApart,
      alreadyShipped: o.order_status === "booked" || o.order_status === "delivered",
    });
  }
  return matches.sort((a, b) => a.hoursApart - b.hoursApart);
}

// Active orders for a phone raised within the window up to now — used to warn
// the operator before a brand-new order for the same number is even saved.
export function recentOrdersForPhone(orders: Order[], phone: string): Order[] {
  const key = phoneKey(phone);
  if (key.length < 9) return [];
  const now = Date.now();
  return orders
    .filter(
      (o) =>
        isActive(o.order_status) &&
        (phoneKey(o.phone_number) === key || phoneKey(o.phone_2) === key) &&
        (now - new Date(o.created_at).getTime()) / 3_600_000 <= DUP_WINDOW_HOURS
    )
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

// Ids of every order that sits in a duplicate cluster — a single grouped pass
// for the list badge, so it stays cheap with many orders. Groups by primary
// phone (the book-time findDuplicates does the stricter both-numbers check).
export function duplicateOrderIds(orders: Order[]): Set<string> {
  const byPhone = new Map<string, Order[]>();
  for (const o of orders) {
    if (!isActive(o.order_status)) continue;
    const key = phoneKey(o.phone_number);
    if (key.length < 9) continue;
    let arr = byPhone.get(key);
    if (!arr) byPhone.set(key, (arr = []));
    arr.push(o);
  }
  const dupes = new Set<string>();
  for (const group of byPhone.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const apart =
          (new Date(group[j].created_at).getTime() - new Date(group[i].created_at).getTime()) /
          3_600_000;
        if (apart > DUP_WINDOW_HOURS) break; // sorted ascending → the rest are only further apart
        dupes.add(group[i].id);
        dupes.add(group[j].id);
      }
    }
  }
  return dupes;
}
