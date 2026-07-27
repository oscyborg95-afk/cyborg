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
  getLeadMemory,
  recordCustomerEvent,
  updateCustomerProfile,
  updateLeadMemoryFromDecision,
  upsertAttention,
} from "./crm-db";
import { chatIdToPhone } from "./phone";
import { phoneKey } from "./risk";
import { decideSalesReply } from "./sales-agent";
import {
  canAutoSendDecision,
  insideQuietHours,
  needsAgentHandoff,
  shouldPauseCustomer,
} from "./agent-policy";
import { sendWhatsAppMessage, workerFetch } from "./wa";
import type { AgentRun, WaMessage } from "./types";

const configuredExecutionTimeout = Number(process.env.AGENT_EXECUTION_TIMEOUT_MS || 40_000);
const AGENT_EXECUTION_TIMEOUT_MS = Number.isFinite(configuredExecutionTimeout)
  ? Math.max(20_000, Math.min(50_000, configuredExecutionTimeout))
  : 40_000;
const configuredMessageAge = Number(process.env.AGENT_MAX_MESSAGE_AGE_MS || 3 * 60_000);
const AGENT_MAX_MESSAGE_AGE_MS = Number.isFinite(configuredMessageAge)
  ? Math.max(30_000, Math.min(15 * 60_000, configuredMessageAge))
  : 3 * 60_000;

export interface AgentTrigger {
  id: string;
  chatId: string;
  body: string;
  fromMe: boolean;
  timestamp: number;
  senderName?: string;
}

class ChatDeletionAbortError extends Error {
  constructor() {
    super("Chat data was deleted");
    this.name = "ChatDeletionAbortError";
  }
}

interface ActiveAgentRun {
  controller: AbortController;
  completed: Promise<void>;
  markCompleted: () => void;
}

const activeAgentRuns = new Map<string, Set<ActiveAgentRun>>();

export async function cancelSalesAgentRuns(chatId: string): Promise<void> {
  const runs = [...(activeAgentRuns.get(chatId) ?? [])];
  for (const run of runs) run.controller.abort(new ChatDeletionAbortError());
  await Promise.all(runs.map((run) => run.completed));
}

function messageTimestampMs(timestamp: number): number {
  return timestamp > 0 && timestamp < 1_000_000_000_000
    ? timestamp * 1000
    : timestamp;
}

function waitForReplyDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export async function runSalesAgent(trigger: AgentTrigger): Promise<AgentRun | null> {
  if (trigger.fromMe || !trigger.id || !trigger.chatId) return null;
  if (
    trigger.chatId.endsWith("@newsletter") ||
    trigger.chatId.endsWith("@g.us") ||
    trigger.chatId === "status@broadcast"
  ) {
    return null;
  }
  const phone = chatIdToPhone(trigger.chatId);
  const key = phoneKey(phone);
  if (key.length < 9) return null;

  const controller = new AbortController();
  let markCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    markCompleted = resolve;
  });
  const activeRun: ActiveAgentRun = { controller, completed, markCompleted };
  const runsForChat = activeAgentRuns.get(trigger.chatId) ?? new Set<ActiveAgentRun>();
  runsForChat.add(activeRun);
  activeAgentRuns.set(trigger.chatId, runsForChat);
  let executionTimedOut = false;
  let stage = "claiming the run";
  let claimed: AgentRun | null = null;
  let replySent = false;
  const executionTimer = setTimeout(() => {
    executionTimedOut = true;
    controller.abort(new Error("Agent execution deadline reached"));
  }, AGENT_EXECUTION_TIMEOUT_MS);
  try {
    claimed = await claimAgentRun({
      trigger_message_id: trigger.id,
      phone_key: key,
      chat_id: trigger.chatId,
    });
    if (!claimed) return null;
    controller.signal.throwIfAborted();

    const occurredAtMs = messageTimestampMs(trigger.timestamp || Date.now());
    if (Date.now() - occurredAtMs > AGENT_MAX_MESSAGE_AGE_MS) {
      return finishAgentRun(trigger.id, {
        status: "skipped",
        error: "Message is too old for an autonomous reply",
      });
    }

    stage = "loading the customer profile";
    let profile = await ensureCustomerProfile({
      phone_key: key,
      primary_phone: phone,
      display_name: trigger.senderName ?? "",
      direction: "inbound",
      occurred_at: new Date(occurredAtMs).toISOString(),
    });
    await recordCustomerEvent({
      phone_key: key,
      chat_id: trigger.chatId,
      kind: "message_in",
      source: "customer",
      payload: { message_id: trigger.id, body: trigger.body.slice(0, 1000) },
    });
    controller.signal.throwIfAborted();

    stage = "loading AI settings";
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
      stage = "waiting for the reply delay";
      await waitForReplyDelay(
        Math.min(config.reply_delay_seconds, 15) * 1000,
        controller.signal
      );
    }

    stage = "loading conversation context";
    const [messages, orders, products, states, settings, leadMemory] = await Promise.all([
      workerFetch<WaMessage[]>(
        `/messages/${encodeURIComponent(trigger.chatId)}?peek=1`,
        { signal: controller.signal }
      ),
      listOrders(true),
      listProducts(),
      listChatStates(),
      getSettings(),
      getLeadMemory(key),
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
    stage = "generating the sales reply";
    const decision = await decideSalesReply({
      config,
      profile,
      leadMemory,
      products,
      orders: customerOrders,
      messages,
      currentState: state?.state ?? "NEW",
      geminiApiKey: settings.gemini_api_key,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();

    // AI generation is the slowest step. Re-read the conversation after it
    // finishes so a reply for an older bubble can never be sent over a newer
    // customer message or a human operator reply.
    stage = "checking for a newer message";
    const currentMessages = await workerFetch<WaMessage[]>(
      `/messages/${encodeURIComponent(trigger.chatId)}?peek=1`,
      { signal: controller.signal }
    );
    const currentLatest = currentMessages[currentMessages.length - 1];
    if (!currentLatest || currentLatest.fromMe || currentLatest.id !== trigger.id) {
      return finishAgentRun(trigger.id, {
        status: "skipped",
        decision,
        error: "A newer message arrived while the AI was preparing this reply",
      });
    }

    stage = "saving the AI decision";
    if (decision.customer_name && !profile.display_name) {
      profile = await updateCustomerProfile(key, { display_name: decision.customer_name });
    }
    await updateLeadMemoryFromDecision(key, decision);

    const needsHandoff = needsAgentHandoff(
      decision.action,
      decision.confidence,
      config.min_confidence
    );
    if (needsHandoff) {
      const pauseCustomer = shouldPauseCustomer(decision);
      if (pauseCustomer) {
        await updateCustomerProfile(key, {
          ai_paused_until: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });
      }
      await upsertAttention({
        unique_key: `ai-handoff:${key}`,
        phone_key: key,
        chat_id: trigger.chatId,
        kind: "ai_handoff",
        priority: pauseCustomer ? "urgent" : "high",
        title: pauseCustomer ? "Customer needs help now" : "AI reply needs review",
        summary:
          decision.handoff_reason ||
          `Confidence ${Math.round(decision.confidence * 100)}% — review this conversation.`,
        payload: { decision, trigger_message_id: trigger.id, customer_paused: pauseCustomer },
      });
      await recordCustomerEvent({
        phone_key: key,
        chat_id: trigger.chatId,
        kind: "ai_handoff",
        source: "agent",
        payload: { decision, customer_paused: pauseCustomer },
      });
      // A confident complaint acknowledgement is safe and avoids leaving an
      // upset customer on read; the AI then pauses until the exception clears.
      if (
        pauseCustomer &&
        config.mode === "auto" &&
        decision.confidence >= config.min_confidence &&
        decision.reply
      ) {
        stage = "sending the escalation acknowledgement";
        await sendWhatsAppMessage(
          trigger.chatId,
          decision.reply,
          undefined,
          trigger.id,
          controller.signal
        );
        replySent = true;
        await ensureCustomerProfile({
          phone_key: key,
          primary_phone: phone,
          direction: "outbound",
        });
      }
      return finishAgentRun(trigger.id, {
        status: pauseCustomer ? "handoff" : "drafted",
        decision,
        reply: decision.reply,
      });
    }

    if (decision.action === "skip" || !decision.reply) {
      return finishAgentRun(trigger.id, { status: "skipped", decision });
    }

    if (config.mode === "draft" || !canAutoSendDecision(decision)) {
      await upsertAttention({
        unique_key: `ai-draft:${key}`,
        phone_key: key,
        chat_id: trigger.chatId,
        kind: "ai_handoff",
        priority: "medium",
        title:
          config.mode === "auto"
            ? "AI held a sensitive sales step for review"
            : "AI reply ready for review",
        summary: decision.reply.slice(0, 260),
        payload: { decision, trigger_message_id: trigger.id },
      });
      return finishAgentRun(trigger.id, {
        status: "drafted",
        decision,
        reply: decision.reply,
      });
    }

    stage = "sending the WhatsApp reply";
    await sendWhatsAppMessage(
      trigger.chatId,
      decision.reply,
      undefined,
      trigger.id,
      controller.signal
    );
    replySent = true;
    controller.signal.throwIfAborted();
    stage = "saving the sent reply";
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
    if (error instanceof ChatDeletionAbortError) return null;
    if (!claimed) throw error;
    const message = executionTimedOut
      ? replySent
        ? `WhatsApp accepted the reply, but the run exceeded ${AGENT_EXECUTION_TIMEOUT_MS / 1000} seconds while ${stage}. Do not retry this message.`
        : `Agent exceeded ${AGENT_EXECUTION_TIMEOUT_MS / 1000} seconds while ${stage}. No reply was sent.`
      : error instanceof Error
        ? error.message
        : "Sales agent failed";
    const finished = await finishAgentRun(trigger.id, {
      status: replySent ? "sent" : "failed",
      error: message,
    });
    if (!executionTimedOut) {
      await upsertAttention({
        unique_key: `agent-failed:${key}`,
        phone_key: key,
        chat_id: trigger.chatId,
        kind: "failed_message",
        priority: "high",
        title: "AI reply failed",
        summary: message,
        payload: { trigger_message_id: trigger.id, stage },
      }).catch(() => {});
    }
    return finished;
  } finally {
    clearTimeout(executionTimer);
    runsForChat.delete(activeRun);
    if (runsForChat.size === 0) activeAgentRuns.delete(trigger.chatId);
    markCompleted();
  }
}
