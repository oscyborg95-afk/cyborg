import type { OrderItem } from "./types";

// Coerce client-supplied line items into a clean OrderItem[] (or null when
// nothing valid remains). Guards against negative quantities/prices and junk.
export function parseItems(raw: unknown): OrderItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items: OrderItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = String(e.name ?? "").trim();
    const qty = Math.floor(Number(e.qty));
    const price = Number(e.price);
    if (!name || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0)
      continue;
    items.push({
      product_id: typeof e.product_id === "string" && e.product_id ? e.product_id : null,
      name,
      qty,
      price,
    });
  }
  return items.length > 0 ? items : null;
}

// Products subtotal of a line-item list.
export function itemsSubtotal(items: OrderItem[]): number {
  return items.reduce((sum, i) => sum + i.qty * i.price, 0);
}

// Human summary for the legacy single-string field: "2× Posture Corrector, 1× Belt".
export function itemsSummary(items: OrderItem[]): string {
  return items.map((i) => (i.qty > 1 ? `${i.qty}× ${i.name}` : i.name)).join(", ");
}
