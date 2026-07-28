import type { Order } from "./types";

export function normalizeCustomerPhone(phone: string): string {
  return phone.replace(/\D/g, "").slice(-9);
}

export function orderIdentityKeys(order: Pick<Order, "phone_number" | "phone_2">): string[] {
  return [
    ...new Set(
      [normalizeCustomerPhone(order.phone_number), normalizeCustomerPhone(order.phone_2)].filter(
        (key) => key.length >= 9
      )
    ),
  ];
}

export function groupOrdersByCustomerIdentity(orders: Order[]): Map<string, Order[]> {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    const current = parent.get(key);
    if (!current) {
      parent.set(key, key);
      return key;
    }
    if (current === key) return key;
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const order of orders) {
    const keys = orderIdentityKeys(order);
    keys.forEach(find);
    if (keys.length > 1) union(keys[0], keys[1]);
  }

  const groups = new Map<string, Order[]>();
  for (const order of orders) {
    const root = orderIdentityKeys(order)[0];
    if (!root) continue;
    const canonical = find(root);
    const rows = groups.get(canonical) ?? [];
    rows.push(order);
    groups.set(canonical, rows);
  }
  return groups;
}
