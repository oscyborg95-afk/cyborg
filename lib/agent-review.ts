import { upsertChatState } from "./db";
import {
  claimAgentDraftReview,
  ensureCustomerProfile,
  finishAgentDraftReview,
  recordCustomerEvent,
  resolveAttentionByUniqueKey,
  upsertAttention,
} from "./crm-db";
import { chatIdToPhone } from "./phone";
import { sendWhatsAppMessage } from "./wa";

export type DraftReviewAction = "approve" | "edit" | "reject";

export async function reviewAgentDraft(input: {
  runId: string;
  action: DraftReviewAction;
  text?: string;
  reason?: string;
}) {
  const run = await claimAgentDraftReview(input.runId);
  if (!run) {
    throw new Error("This draft was already reviewed or is no longer available.");
  }

  const reason = input.reason?.trim().slice(0, 200) ?? "";
  const finalReply =
    input.action === "edit" ? input.text?.trim().slice(0, 1600) ?? "" : run.reply.trim();

  if (input.action === "edit" && !finalReply) {
    await finishAgentDraftReview(run.id, { status: "pending" });
    throw new Error("Edited reply cannot be empty.");
  }

  if (input.action === "reject") {
    const reviewed = await finishAgentDraftReview(run.id, {
      status: "rejected",
      reason: reason || "other",
    });
    await recordCustomerEvent({
      phone_key: run.phone_key,
      chat_id: run.chat_id,
      kind: "ai_feedback",
      source: "operator",
      payload: {
        run_id: run.id,
        action: "rejected",
        reason: reason || "other",
        original_reply: run.reply,
      },
    });
    await resolveAttentionByUniqueKey(`ai-draft:${run.phone_key}`);
    return reviewed;
  }

  if (!finalReply) {
    await finishAgentDraftReview(run.id, { status: "pending" });
    throw new Error("Draft reply is empty.");
  }

  let messageSent = false;
  try {
    await sendWhatsAppMessage(run.chat_id, finalReply);
    messageSent = true;
    const phone = chatIdToPhone(run.chat_id);
    await ensureCustomerProfile({
      phone_key: run.phone_key,
      primary_phone: phone,
      direction: "outbound",
    });
    if (run.decision) {
      await upsertChatState(
        phone,
        run.chat_id,
        run.decision.next_state,
        run.decision.customer_name
      );
    }
    const feedbackStatus = input.action === "edit" ? "edited" : "approved";
    const reviewed = await finishAgentDraftReview(run.id, {
      status: feedbackStatus,
      reason,
      finalReply,
      sent: true,
    });
    await recordCustomerEvent({
      phone_key: run.phone_key,
      chat_id: run.chat_id,
      kind: "ai_feedback",
      source: "operator",
      payload: {
        run_id: run.id,
        action: feedbackStatus,
        reason,
        original_reply: run.reply,
        final_reply: finalReply,
      },
    });
    await recordCustomerEvent({
      phone_key: run.phone_key,
      chat_id: run.chat_id,
      kind: "message_out",
      source: "operator",
      payload: { body: finalReply, approved_ai_draft: true, run_id: run.id },
    });
    await resolveAttentionByUniqueKey(`ai-draft:${run.phone_key}`);

    if (run.decision?.order_ready) {
      await upsertAttention({
        unique_key: `order-ready:${run.phone_key}`,
        phone_key: run.phone_key,
        chat_id: run.chat_id,
        kind: "order_ready",
        priority: "urgent",
        title: "Order ready to dispatch",
        summary:
          run.decision.summary ||
          "AI collected the details and the customer confirmed COD.",
        payload: { decision: run.decision, trigger_message_id: run.trigger_message_id },
      });
    }
    return reviewed;
  } catch (error) {
    if (!messageSent) {
      await finishAgentDraftReview(run.id, { status: "pending" }).catch(() => {});
    }
    throw error;
  }
}
