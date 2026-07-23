import { getTrackingHealth, listChatStates } from "./db";
import { listAttention, upsertAttention } from "./crm-db";
import { listCustomerSummaries } from "./customers";
import { chatIdToPhone } from "./phone";
import { phoneKey } from "./risk";
import { workerFetch } from "./wa";
import type { AttentionItem, CustomerSummary, WaChat } from "./types";

const TWO_HOURS = 2 * 60 * 60 * 1000;

export async function syncAttentionCenter(): Promise<void> {
  const [chats, states, health] = await Promise.all([
    workerFetch<WaChat[]>("/chats").catch(() => []),
    listChatStates(),
    getTrackingHealth().catch(() => null),
  ]);
  const now = Date.now();
  const stateByKey = new Map(states.map((state) => [phoneKey(state.phone_number), state]));

  for (const chat of chats) {
    const phone = chatIdToPhone(chat.id);
    const key = phoneKey(phone);
    if (key.length < 9) continue;
    const age = Math.max(0, now - Number(chat.timestamp || now));
    if (chat.unreadCount > 0) {
      await upsertAttention({
        unique_key: `unreplied:${key}`,
        phone_key: key,
        chat_id: chat.id,
        kind: "unreplied",
        priority: age > 30 * 60 * 1000 ? "high" : "medium",
        title: `${chat.name || phone} is waiting`,
        summary: chat.lastMessage.slice(0, 240),
        due_at: new Date(Number(chat.timestamp || now) + 15 * 60 * 1000).toISOString(),
        payload: { unread_count: chat.unreadCount, message_age_ms: age },
      });
    }
    const state = stateByKey.get(key);
    if (!state || now - new Date(state.updated_at).getTime() < TWO_HOURS) continue;
    if (state.state === "AWAITING_ADDRESS") {
      await upsertAttention({
        unique_key: `stale-address:${key}`,
        phone_key: key,
        chat_id: chat.id,
        kind: "stale_address",
        priority: "medium",
        title: "Address still missing",
        summary: `${chat.name || phone} has not completed delivery details.`,
        due_at: state.updated_at,
      });
    } else if (state.state === "AWAITING_CONFIRMATION") {
      await upsertAttention({
        unique_key: `stale-confirmation:${key}`,
        phone_key: key,
        chat_id: chat.id,
        kind: "stale_confirmation",
        priority: "high",
        title: "Sale waiting for confirmation",
        summary: `${chat.name || phone} reached COD confirmation but has not replied.`,
        due_at: state.updated_at,
      });
    }
  }

  for (const problem of health?.problems ?? []) {
    const key = phoneKey(problem.phone_number);
    await upsertAttention({
      unique_key: `delivery:${problem.order_id}:${problem.status}`,
      phone_key: key,
      kind: "delivery_problem",
      priority: "urgent",
      title: `Delivery problem · ${problem.order_no || problem.tracking_id}`,
      summary: problem.checkpoint || problem.status,
      due_at: problem.occurred_at,
      payload: { ...problem },
    });
  }
}

function customerValue(customer: CustomerSummary | null | undefined): number {
  if (!customer) return 0;
  return customer.active_orders > 0
    ? customer.lifetime_revenue / Math.max(customer.delivered_orders, 1)
    : 0;
}

export async function getAttentionFeed(): Promise<{
  items: AttentionItem[];
  counts: Record<string, number>;
  estimated_value: number;
}> {
  await syncAttentionCenter();
  const [items, customers] = await Promise.all([
    listAttention(),
    listCustomerSummaries(),
  ]);
  const customerByKey = new Map(customers.map((customer) => [customer.phone_key, customer]));
  const now = Date.now();
  const visible = items
    .filter(
      (item) =>
        item.status === "open" ||
        (item.status === "snoozed" &&
          item.snoozed_until &&
          new Date(item.snoozed_until).getTime() <= now)
    )
    .map((item) => ({ ...item, customer: customerByKey.get(item.phone_key) ?? null }));
  const counts = visible.reduce<Record<string, number>>(
    (acc, item) => {
      acc.all++;
      acc[item.kind] = (acc[item.kind] ?? 0) + 1;
      acc[item.priority] = (acc[item.priority] ?? 0) + 1;
      return acc;
    },
    { all: 0 }
  );
  return {
    items: visible,
    counts,
    estimated_value: visible
      .filter((item) =>
        ["unreplied", "stale_address", "stale_confirmation", "order_ready"].includes(item.kind)
      )
      .reduce((sum, item) => sum + customerValue(item.customer), 0),
  };
}
