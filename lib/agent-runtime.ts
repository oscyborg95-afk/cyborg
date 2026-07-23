import {
  getSettings,
  listChatStates,
  listOrders,
  listProducts,
  upsertChatState,
} from "./db";
import {
  claimAgentRun,
  ensureCustomerProfile,
  finishAgentRun,
  getAgentConfig,
  recordCustomerEvent,
  updateCustomerProfile,
  upsertAttention,
} from "./crm-db";
import { chatIdToPhone } from "./phone";
import { phoneKey } from "./risk";
import { decideSalesReply } from "./sales-agent";
import { insideQuietHours, needsAgentHandoff } from "./agent-policy";
import { sendWhatsAppMessage, workerFetch } from "./wa";
import type { AgentRun, WaMessage } from "./types";

export interface AgentTrigger {
  id: string;
  chatId: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  senderName?: string;
}

export async function runSalesAgent(trigger: AgentTrigger): Promise<AgentRun | null> {
  if (trigger.fromMe || !trigger.id || !trigger.chatId) return null;
  const phone = chatIdToPhone(trigger.chatId);
  const key = phoneKey(phone);
  if (key.length < 9) return null;

  const claimed = await claimAgentRun({
    trigger_message_id: trigger.id,
    phone_key: key,
    chat_id: trigger.chatId,
  });
  if (!claimed) return null;

  const occurredAt = new Date(trigger.timestamp || Date.now()).toISOString();
  let profile = await ensureCustomerProfile({
    phone_key: key,
    primary_phone: phone,
    display_name: trigger.senderName ?? "",
    direction: "inbound",
    occurred_at: occurredAt,
  });
  await recordCustomerEvent({
    phone_key: key,
    chat_id: trigger.chatId,
    kind: "message_in",
    source: "customer",
    payload: { message_id: trigger.id, body: trigger.body.slice(0, 1000) },
  });

  try {
    const config = await getAgentConfig();
    if (config.mode === "off") {
      return finishAgentRun(trigger.id, { status: "skipped", error: "Agent is off" });
    }
    if (
      !profile.ai_enabled ||
      (profile.ai_paused_until && new Date(profile.ai_paused_until).getTime() > Date.now())
    ) {
      return finishAgentRun(trigger.id, {
        status: "skipped",
        error: "AI is paused for this customer",
      });
    }
    if (insideQuietHours(config)) {
      await upsertAttention({
        unique_key: `quiet:${key}`,
        phone_key: key,
        chat_id: trigger.chatId,
        kind: "unreplied",
        priority: "medium",
        title: "Customer messaged during quiet hours",
        summary: trigger.body.slice(0, 220),
        due_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      });
      return finishAgentRun(trigger.id, {
        status: "skipped",
        error: "Inside configured quiet hours",
      });
    }

    // A short human-like delay also gives multi-bubble addresses time to land.
    // The latest-message check below makes older overlapping turns harmless.
    if (config.reply_delay_seconds > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(config.reply_delay_seconds, 45) * 1000)
      );
    }

    const [messages, orders, products, states, settings] = await Promise.all([
      workerFetch<WaMessage[]>(
        `/messages/${encodeURIComponent(trigger.chatId)}?peek=1`
      ),
      listOrders(true),
      listProducts(),
      listChatStates(),
      getSettings(),
    ]);
    const latest = messages[messages.length - 1];
    if (!latest || latest.fromMe || latest.id !== trigger.id) {
      return finishAgentRun(trigger.id, {
        status: "skipped",
        error: "A newer message already superseded this trigger",
      });
    }

    const customerOrders = orders.filter(
      (order) =>
        phoneKey(order.phone_number) === key ||
        (order.phone_2 && phoneKey(order.phone_2) === key)
    );
    const state = states.find((entry) => phoneKey(entry.phone_number) === key);
    const decision = await decideSalesReply({
      config,
      profile,
      products,
      orders: customerOrders,
      messages,
      currentState: state?.state ?? "NEW",
      geminiApiKey: settings.gemini_api_key,
    });

    if (decision.customer_name && !profile.display_name) {
      profile = await updateCustomerProfile(key, { display_name: decision.customer_name });
    }
    if (profile.preferred_language === "auto") {
      profile = await updateCustomerProfile(key, {
        preferred_language: decision.language,
      });
    }

    const needsHandoff = needsAgentHandoff(
      decision.action,
      decision.confidence,
      config.min_confidence
    );
    if (needsHandoff) {
      await updateCustomerProfile(key, {
        ai_paused_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      await upsertAttention({
        unique_key: `ai-handoff:${key}`,
        phone_key: key,
        chat_id: trigger.chatId,
        kind: "ai_handoff",
        priority: decision.intent === "complaint" ? "urgent" : "high",
        title: decision.intent === "complaint" ? "Customer needs help now" : "AI needs a decision",
        summary:
          decision.handoff_reason ||
          `Confidence ${Math.round(decision.confidence * 100)}% — review this conversation.`,
        payload: { decision, trigger_message_id: trigger.id },
      });
      await recordCustomerEvent({
        phone_key: key,
        chat_id: trigger.chatId,
        kind: "ai_handoff",
        source: "agent",
        payload: { decision },
      });
      // A confident complaint acknowledgement is safe and avoids leaving an
      // upset customer on read; the AI then pauses until the exception clears.
      if (
        config.mode === "auto" &&
        decision.confidence >= config.min_confidence &&
        decision.reply
      ) {
        await sendWhatsAppMessage(trigger.chatId, decision.reply);
        await ensureCustomerProfile({
          phone_key: key,
          primary_phone: phone,
          direction: "outbound",
        });
      }
      return finishAgentRun(trigger.id, {
        status: "handoff",
        decision,
        reply: decision.reply,
      });
    }

    if (decision.action === "skip" || !decision.reply) {
      return finishAgentRun(trigger.id, { status: "skipped", decision });
    }

    if (config.mode === "draft") {
      await upsertAttention({
        unique_key: `ai-draft:${key}`,
        phone_key: key,
        chat_id: trigger.chatId,
        kind: "ai_handoff",
        priority: "medium",
        title: "AI reply ready for review",
        summary: decision.reply.slice(0, 260),
        payload: { decision, trigger_message_id: trigger.id },
      });
      return finishAgentRun(trigger.id, {
        status: "drafted",
        decision,
        reply: decision.reply,
      });
    }

    await sendWhatsAppMessage(trigger.chatId, decision.reply);
    await ensureCustomerProfile({
      phone_key: key,
      primary_phone: phone,
      direction: "outbound",
    });
    await upsertChatState(phone, trigger.chatId, decision.next_state, profile.display_name);
    await recordCustomerEvent({
      phone_key: key,
      chat_id: trigger.chatId,
      kind: "ai_reply",
      source: "agent",
      payload: {
        trigger_message_id: trigger.id,
        reply: decision.reply,
        decision,
      },
    });

    if (decision.order_ready) {
      await upsertAttention({
        unique_key: `order-ready:${key}`,
        phone_key: key,
        chat_id: trigger.chatId,
        kind: "order_ready",
        priority: "urgent",
        title: "Order ready to dispatch",
        summary: decision.summary || "AI collected the details and the customer confirmed COD.",
        payload: { decision, trigger_message_id: trigger.id },
      });
      await recordCustomerEvent({
        phone_key: key,
        chat_id: trigger.chatId,
        kind: "order_ready",
        source: "agent",
        payload: { decision },
      });
    }

    return finishAgentRun(trigger.id, {
      status: "sent",
      decision,
      reply: decision.reply,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sales agent failed";
    await upsertAttention({
      unique_key: `agent-failed:${key}`,
      phone_key: key,
      chat_id: trigger.chatId,
      kind: "failed_message",
      priority: "high",
      title: "AI reply failed",
      summary: message,
      payload: { trigger_message_id: trigger.id },
    }).catch(() => {});
    return finishAgentRun(trigger.id, {
      status: "failed",
      error: message,
    });
  }
}
