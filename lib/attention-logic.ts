import type { AttentionItem, AttentionKind } from "./types";

export type ActionCategory = "customers" | "orders" | "delivery" | "system";

export function attentionCategory(kind: AttentionKind): ActionCategory {
  if (["unreplied", "stale_address", "stale_confirmation"].includes(kind)) return "customers";
  if (kind === "order_ready") return "orders";
  if (kind === "delivery_problem") return "delivery";
  return "system";
}

export function occurrenceKey(kind: string, identity: string, occurredAt: string | number): string {
  return `${kind}:${identity}:${String(occurredAt)}`;
}

export function sortAttentionItems<T extends Pick<AttentionItem, "priority" | "due_at" | "created_at">>(
  items: T[]
): T[] {
  const rank = { urgent: 0, high: 1, medium: 2, low: 3 };
  return [...items].sort((a, b) => {
    const priority = rank[a.priority] - rank[b.priority];
    if (priority !== 0) return priority;
    const due = Date.parse(a.due_at ?? a.created_at) - Date.parse(b.due_at ?? b.created_at);
    return due || a.created_at.localeCompare(b.created_at);
  });
}
