import { getOrder, getTrackingHealth, listChatStates, listPendingOrders } from "./db";
import { listAttention, reconcileDerivedAttention, upsertAttention } from "./crm-db";
import { attentionCategory, occurrenceKey, sortAttentionItems } from "./attention-logic";
import { listCustomerSummaries } from "./customers";
import { chatIdToPhone } from "./phone";
import { phoneKey } from "./risk";
import { workerFetch } from "./wa";
import type { AttentionItem, AttentionKind, CustomerSummary, WaChat } from "./types";

const TWO_HOURS = 2 * 60 * 60 * 1000;
const DERIVED_KINDS: AttentionKind[] = [
  "unreplied",
  "stale_address",
  "stale_confirmation",
  "order_ready",
  "delivery_problem",
];

export async function syncAttentionCenter(): Promise<void> {
  const [chats, states, health, pendingOrders] = await Promise.all([
    workerFetch<WaChat[]>("/chats").catch(() => []),
    listChatStates(),
    getTrackingHealth().catch(() => null),
    listPendingOrders(),
  ]);
  const now = Date.now();
  const activeKeys: string[] = [];
  const stateByKey = new Map(states.map((state) => [phoneKey(state.phone_number), state]));
  const chatByKey = new Map(chats.map((chat) => [phoneKey(chatIdToPhone(chat.id)), chat]));

  for (const chat of chats) {
    const phone = chatIdToPhone(chat.id);
    const key = phoneKey(phone);
    if (key.length < 9) continue;
    const messageAt = Number(chat.timestamp || now);
    const age = Math.max(0, now - messageAt);
    if (chat.unreadCount > 0) {
      const uniqueKey = occurrenceKey("unreplied", key, messageAt);
      activeKeys.push(uniqueKey);
      await upsertAttention({
        unique_key: uniqueKey,
        phone_key: key,
        chat_id: chat.id,
        kind: "unreplied",
        priority: age > 30 * 60 * 1000 ? "high" : "medium",
        title: `${chat.name || phone} needs a reply`,
        summary: `Why it is here: ${chat.unreadCount} unread message${chat.unreadCount === 1 ? "" : "s"}. ${chat.lastMessage.slice(0, 180)}`,
        due_at: new Date(messageAt + 15 * 60 * 1000).toISOString(),
        payload: { unread_count: chat.unreadCount, message_age_ms: age },
      });
    }

    const state = stateByKey.get(key);
    if (!state || now - new Date(state.updated_at).getTime() < TWO_HOURS) continue;
    if (state.state === "AWAITING_ADDRESS" || state.state === "AWAITING_CONFIRMATION") {
      const isAddress = state.state === "AWAITING_ADDRESS";
      const kind: AttentionKind = isAddress ? "stale_address" : "stale_confirmation";
      const uniqueKey = occurrenceKey(kind, key, state.updated_at);
      activeKeys.push(uniqueKey);
      await upsertAttention({
        unique_key: uniqueKey,
        phone_key: key,
        chat_id: chat.id,
        kind,
        priority: isAddress ? "medium" : "high",
        title: isAddress ? "Delivery address is still missing" : "Order confirmation is waiting",
        summary: isAddress
          ? `Why it is here: ${chat.name || phone} has not completed the delivery details.`
          : `Why it is here: ${chat.name || phone} reached COD confirmation but has not replied.`,
        due_at: state.updated_at,
      });
    }
  }

  for (const order of pendingOrders) {
    const key = phoneKey(order.phone_number);
    const uniqueKey = occurrenceKey("pending-order", order.id, order.created_at);
    activeKeys.push(uniqueKey);
    await upsertAttention({
      unique_key: uniqueKey,
      phone_key: key,
      chat_id: chatByKey.get(key)?.id ?? null,
      kind: "order_ready",
      priority: "high",
      title: `${order.order_no || "Order"} is ready for dispatch review`,
      summary: `Why it is here: the order is pending and has not been booked with the courier.`,
      due_at: order.created_at,
      payload: {
        order_id: order.id,
        order_no: order.order_no,
        total_cod: Number(order.total_cod || 0),
        customer_name: order.customer_name,
      },
    });
  }

  for (const problem of health?.problems ?? []) {
    const key = phoneKey(problem.phone_number);
    const uniqueKey = occurrenceKey(
      "delivery",
      `${problem.order_id}:${problem.status}`,
      problem.occurred_at
    );
    activeKeys.push(uniqueKey);
    const matchingOrder = await getOrder(problem.order_id);
    await upsertAttention({
      unique_key: uniqueKey,
      phone_key: key,
      chat_id: chatByKey.get(key)?.id ?? null,
      kind: "delivery_problem",
      priority: "urgent",
      title: `Delivery needs review · ${problem.order_no || problem.tracking_id}`,
      summary: `Why it is here: ${problem.checkpoint || problem.status}`,
      due_at: problem.occurred_at,
      payload: {
        ...problem,
        ...(matchingOrder ? { total_cod: Number(matchingOrder.total_cod || 0) } : {}),
      },
    });
  }

  await reconcileDerivedAttention(activeKeys, DERIVED_KINDS);
}

export async function getAttentionFeed(): Promise<{
  items: AttentionItem[];
  counts: Record<string, number>;
  cod_at_risk: number;
}> {
  await syncAttentionCenter();
  const [items, customers] = await Promise.all([listAttention(), listCustomerSummaries()]);
  const customerByKey = new Map(customers.map((customer) => [customer.phone_key, customer]));
  const now = Date.now();
  const visible = sortAttentionItems(
    items
      .filter(
        (item) =>
          item.status === "open" ||
          (item.status === "snoozed" &&
            item.snoozed_until &&
            new Date(item.snoozed_until).getTime() <= now)
      )
      .map((item) => ({ ...item, customer: customerByKey.get(item.phone_key) ?? null }))
  );
  const counts = visible.reduce<Record<string, number>>(
    (acc, item) => {
      acc.all++;
      acc[attentionCategory(item.kind)] = (acc[attentionCategory(item.kind)] ?? 0) + 1;
      acc[item.priority] = (acc[item.priority] ?? 0) + 1;
      return acc;
    },
    { all: 0, customers: 0, orders: 0, delivery: 0, system: 0 }
  );
  return {
    items: visible,
    counts,
    cod_at_risk: visible.reduce((sum, item) => {
      const value = Number(item.payload.total_cod);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0),
  };
}

export type ActionQueueCustomer = CustomerSummary;
