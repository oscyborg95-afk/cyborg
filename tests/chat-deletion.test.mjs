import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ensureCustomerProfile,
  getCustomerProfile,
  listAttention,
  listCustomerEvents,
  purgeCustomerData,
  recordCustomerEvent,
  upsertAttention,
} = await jiti.import("../lib/crm-db.ts");
const {
  deleteChatState,
  listChatStates,
  upsertChatState,
} = await jiti.import("../lib/db.ts");

test("chat deletion purges CRM and funnel state while leaving business records out of scope", async () => {
  const phone = "0771234568";
  const phoneKey = "771234568";
  const chatId = "94771234568@s.whatsapp.net";

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
  await upsertChatState(phone, chatId, "AWAITING_CONFIRMATION", "Delete Test");

  const purged = await purgeCustomerData(phoneKey, chatId);
  const deletedStates = await deleteChatState(phone, chatId);

  assert.equal(purged.profiles, 1);
  assert.equal(purged.events, 1);
  assert.equal(purged.attentionItems, 1);
  assert.equal(deletedStates, 1);
  assert.equal(await getCustomerProfile(phoneKey), null);
  assert.deepEqual(await listCustomerEvents(phoneKey), []);
  assert.equal((await listAttention()).some((item) => item.phone_key === phoneKey), false);
  assert.equal(
    (await listChatStates()).some((state) => state.chat_id === chatId),
    false
  );
});
