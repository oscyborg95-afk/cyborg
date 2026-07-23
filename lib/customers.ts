import {
  listChatStates,
  listCustomerAlerts,
  listManifests,
  listOrders,
  listTrackingEvents,
} from "./db";
import {
  ensureCustomerProfile,
  getCustomerProfile,
  listAgentRuns,
  listCustomerEvents,
  listCustomerProfiles,
} from "./crm-db";
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

function blankProfile(phone_key: string, phone: string, name = ""): CustomerProfile {
  const now = new Date(0).toISOString();
  return {
    phone_key,
    primary_phone: phone,
    display_name: name,
    preferred_language: "auto",
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
  const delivered = customerOrders.filter((order) => order.order_status === "delivered");
  const returned = customerOrders.filter((order) => order.order_status === "returned");
  const active = customerOrders.filter(
    (order) => order.order_status === "pending" || order.order_status === "booked"
  );
  return {
    ...profile,
    display_name:
      profile.display_name ||
      chat?.name ||
      customerOrders[0]?.customer_name ||
      profile.primary_phone,
    chat_id: chat?.id ?? state?.chat_id ?? null,
    chat_state: state?.state ?? null,
    delivered_orders: delivered.length,
    returned_orders: returned.length,
    active_orders: active.length,
    lifetime_revenue: delivered.reduce((sum, order) => sum + Number(order.total_cod), 0),
    last_order_at: customerOrders[0]?.created_at ?? null,
    latest_message: chat?.lastMessage ?? "",
    latest_message_at: chat?.timestamp ?? null,
    unread_count: chat?.unreadCount ?? 0,
  };
}

export async function listCustomerSummaries(): Promise<CustomerSummary[]> {
  const [profiles, orders, states, chats] = await Promise.all([
    listCustomerProfiles(),
    listOrders(true),
    listChatStates(),
    workerFetch<WaChat[]>("/chats").catch(() => []),
  ]);
  const keys = new Set<string>(profiles.map((profile) => profile.phone_key));
  for (const order of orders) keys.add(phoneKey(order.phone_number));
  for (const state of states) keys.add(phoneKey(state.phone_number));
  for (const chat of chats) keys.add(phoneKey(chatIdToPhone(chat.id)));

  const profileByKey = new Map(profiles.map((profile) => [profile.phone_key, profile]));
  return [...keys]
    .filter((key) => key.length >= 9)
    .map((key) => {
      const customerOrders = orders
        .filter(
          (order) =>
            phoneKey(order.phone_number) === key ||
            (order.phone_2 && phoneKey(order.phone_2) === key)
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const state = states.find((entry) => phoneKey(entry.phone_number) === key);
      const chat = chats.find((entry) => phoneKey(chatIdToPhone(entry.id)) === key);
      const phone =
        profileByKey.get(key)?.primary_phone ||
        state?.phone_number ||
        customerOrders[0]?.phone_number ||
        (chat ? chatIdToPhone(chat.id) : key);
      const profile =
        profileByKey.get(key) ??
        blankProfile(key, phone, chat?.name || customerOrders[0]?.customer_name || "");
      return summarize(profile, customerOrders, state, chat);
    })
    .sort(
      (a, b) =>
        (b.latest_message_at ?? new Date(b.updated_at).getTime()) -
        (a.latest_message_at ?? new Date(a.updated_at).getTime())
    );
}

export async function getCustomerDetail(phoneKeyValue: string) {
  const key = phoneKey(phoneKeyValue);
  const [summaries, orders, manifests, trackingEvents, alerts, events, runs] =
    await Promise.all([
      listCustomerSummaries(),
      listOrders(true),
      listManifests(),
      listTrackingEvents(),
      listCustomerAlerts(),
      listCustomerEvents(key),
      listAgentRuns(key),
    ]);
  let customer = summaries.find((entry) => entry.phone_key === key) ?? null;
  if (!customer) {
    const profile =
      (await getCustomerProfile(key)) ??
      (await ensureCustomerProfile({ phone_key: key, primary_phone: phoneKeyValue }));
    customer = summarize(profile, [], undefined, undefined);
  }
  const customerOrders = orders.filter(
    (order) =>
      phoneKey(order.phone_number) === key ||
      (order.phone_2 && phoneKey(order.phone_2) === key)
  );
  const orderIds = new Set(customerOrders.map((order) => order.id));
  const messages = customer.chat_id
    ? await workerFetch<WaMessage[]>(
        `/messages/${encodeURIComponent(customer.chat_id)}?peek=1`
      ).catch(() => [])
    : [];
  return {
    customer,
    orders: customerOrders,
    manifests: manifests.filter((manifest) => orderIds.has(manifest.order_id)),
    tracking_events: trackingEvents.filter((event) => orderIds.has(event.order_id)),
    alerts: alerts.filter((alert) => orderIds.has(alert.order_id)),
    events,
    agent_runs: runs,
    messages: messages.slice(-50),
  };
}
