import {
  listChatStates,
  listCustomerAlerts,
  listCustomerOrders,
  listManifests,
  listOrdersForCrm,
  listTrackingEvents,
} from "./db";
import {
  ensureCustomerProfile,
  getCustomerProfile,
  listAgentRuns,
  listCustomerEvents,
  listCustomerProfiles,
} from "./crm-db";
import {
  groupOrdersByCustomerIdentity,
  orderIdentityKeys,
} from "./customer-identity";
import { chatIdToPhone } from "./phone";
import { phoneKey } from "./risk";
import { workerFetch } from "./wa";
import type {
  CustomerProfile,
  CustomerSummary,
  Order,
  WaChat,
  WaMessage,
} from "./types";

function blankProfile(key: string, phone: string, name = ""): CustomerProfile {
  const now = new Date(0).toISOString();
  return {
    phone_key: key,
    primary_phone: phone,
    display_name: name,
    preferred_language: "auto",
    language_locked: false,
    tags: [],
    notes: "",
    ai_enabled: true,
    ai_paused_until: null,
    last_inbound_at: null,
    last_outbound_at: null,
    created_at: now,
    updated_at: now,
  };
}

function summarize(
  profile: CustomerProfile,
  customerOrders: Order[],
  state: Awaited<ReturnType<typeof listChatStates>>[number] | undefined,
  chat: WaChat | undefined
): CustomerSummary {
  const sorted = [...customerOrders].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const delivered = sorted.filter((order) => order.order_status === "delivered");
  const returned = sorted.filter((order) => order.order_status === "returned");
  const active = sorted.filter((order) => order.order_status === "pending" || order.order_status === "booked");
  return {
    ...profile,
    display_name: profile.display_name || chat?.name || sorted[0]?.customer_name || profile.primary_phone,
    chat_id: chat?.id ?? state?.chat_id ?? null,
    chat_state: state?.state ?? null,
    delivered_orders: delivered.length,
    returned_orders: returned.length,
    active_orders: active.length,
    total_orders: sorted.length,
    active_cod_total: active.reduce((sum, order) => sum + Number(order.total_cod || 0), 0),
    lifetime_revenue: delivered.reduce((sum, order) => sum + Number(order.total_cod || 0), 0),
    last_order_at: sorted[0]?.created_at ?? null,
    latest_message: chat?.lastMessage ?? "",
    latest_message_at: chat?.timestamp ?? null,
    unread_count: chat?.unreadCount ?? 0,
  };
}

export async function listCustomerSummaries(): Promise<CustomerSummary[]> {
  const [profiles, orders, states, chats] = await Promise.all([
    listCustomerProfiles(),
    listOrdersForCrm(),
    listChatStates(),
    workerFetch<WaChat[]>("/chats").catch(() => []),
  ]);
  const orderGroups = groupOrdersByCustomerIdentity(orders);
  const aliases = new Map<string, string>();
  for (const [canonical, rows] of orderGroups) {
    for (const order of rows) for (const key of orderIdentityKeys(order)) aliases.set(key, canonical);
  }
  const canonical = (key: string) => aliases.get(key) ?? key;
  const allKeys = new Set<string>();
  profiles.forEach((profile) => allKeys.add(canonical(profile.phone_key)));
  orderGroups.forEach((_rows, key) => allKeys.add(key));
  states.forEach((state) => allKeys.add(canonical(phoneKey(state.phone_number))));
  chats.forEach((chat) => allKeys.add(canonical(phoneKey(chatIdToPhone(chat.id)))));

  return [...allKeys]
    .filter((key) => key.length >= 9)
    .map((key) => {
      const customerOrders = orderGroups.get(key) ?? [];
      const profile =
        profiles.find((entry) => canonical(entry.phone_key) === key) ??
        blankProfile(
          key,
          customerOrders[0]?.phone_number ||
            states.find((entry) => canonical(phoneKey(entry.phone_number)) === key)?.phone_number ||
            key,
          customerOrders[0]?.customer_name || ""
        );
      const state = states.find((entry) => canonical(phoneKey(entry.phone_number)) === key);
      const chat = chats.find((entry) => canonical(phoneKey(chatIdToPhone(entry.id))) === key);
      return summarize({ ...profile, phone_key: key }, customerOrders, state, chat);
    })
    .sort((a, b) => {
      const aTime = a.latest_message_at ?? Date.parse(a.last_order_at ?? a.updated_at);
      const bTime = b.latest_message_at ?? Date.parse(b.last_order_at ?? b.updated_at);
      return bTime - aTime;
    });
}

export async function getCustomerDetail(phoneKeyValue: string) {
  const key = phoneKey(phoneKeyValue);
  const [summaries, orders, manifests, trackingEvents, alerts, events, runs] = await Promise.all([
    listCustomerSummaries(),
    listCustomerOrders(key),
    listManifests(),
    listTrackingEvents(),
    listCustomerAlerts(),
    listCustomerEvents(key),
    listAgentRuns(key),
  ]);
  let customer =
    summaries.find(
      (entry) =>
        entry.phone_key === key ||
        phoneKey(entry.primary_phone) === key ||
        orders.some((order) => orderIdentityKeys(order).includes(entry.phone_key))
    ) ?? null;
  if (!customer) {
    const profile =
      (await getCustomerProfile(key)) ??
      (await ensureCustomerProfile({ phone_key: key, primary_phone: phoneKeyValue }));
    customer = summarize(profile, orders, undefined, undefined);
  }
  const orderIds = new Set(orders.map((order) => order.id));
  const messages = customer.chat_id
    ? await workerFetch<WaMessage[]>(`/messages/${encodeURIComponent(customer.chat_id)}?peek=1`).catch(() => [])
    : [];
  return {
    customer,
    orders,
    manifests: manifests.filter((manifest) => orderIds.has(manifest.order_id)),
    tracking_events: trackingEvents.filter((event) => orderIds.has(event.order_id)),
    alerts: alerts.filter((alert) => orderIds.has(alert.order_id)),
    events,
    agent_runs: runs,
    messages: messages.slice(-50),
  };
}
