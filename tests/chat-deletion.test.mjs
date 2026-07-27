import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  claimAgentRun,
  ensureCustomerProfile,
  getCustomerProfile,
  getLeadMemory,
  listAgentRuns,
  listAttention,
  listCustomerEvents,
  purgeCustomerData,
  recordCustomerEvent,
  updateLeadMemoryFromDecision,
  upsertAttention,
} = await jiti.import("../lib/crm-db.ts");
const {
  deleteChatState,
  listChatStates,
  upsertChatState,
} = await jiti.import("../lib/db.ts");

test("chat deletion purges CRM, AI, and funnel state while leaving business records out of scope", async () => {
  const phone = "0771234568";
  const phoneKey = "771234568";
  const chatId = "94771234568@s.whatsapp.net";
  const triggerId = "delete-chat-test-trigger";

  await ensureCustomerProfile({
    phone_key: phoneKey,
    primary_phone: phone,
    display_name: "Delete Test",
  });
  await recordCustomerEvent({
    phone_key: phoneKey,
    chat_id: chatId,
    kind: "message_in",
    source: "customer",
  });
  await upsertAttention({
    unique_key: `delete-test:${phoneKey}`,
    phone_key: phoneKey,
    chat_id: chatId,
    kind: "unreplied",
    priority: "medium",
    title: "Delete test",
  });
  await claimAgentRun({
    trigger_message_id: triggerId,
    phone_key: phoneKey,
    chat_id: chatId,
  });
  await updateLeadMemoryFromDecision(phoneKey, {
    language: "en",
    language_style: "en",
    language_confidence: 0.99,
    customer_name: "Delete Test",
    interested_product: "Test product",
    quantity: 1,
    customer_need: "Testing",
    objection: "",
    buying_intent: "high",
    next_action: "Confirm",
  });
  await upsertChatState(phone, chatId, "AWAITING_CONFIRMATION", "Delete Test");

  const purged = await purgeCustomerData(phoneKey, chatId);
  const deletedStates = await deleteChatState(phone, chatId);

  assert.equal(purged.profiles, 1);
  assert.equal(purged.events, 1);
  assert.equal(purged.attentionItems, 1);
  assert.equal(purged.agentRuns, 1);
  assert.equal(purged.leadMemories, 1);
  assert.equal(deletedStates, 1);
  assert.equal(await getCustomerProfile(phoneKey), null);
  assert.deepEqual(await listCustomerEvents(phoneKey), []);
  assert.equal((await listAttention()).some((item) => item.phone_key === phoneKey), false);
  assert.deepEqual(await listAgentRuns(phoneKey), []);
  assert.equal(await getLeadMemory(phoneKey), null);
  assert.equal(
    (await listChatStates()).some((state) => state.chat_id === chatId),
    false
  );
});
