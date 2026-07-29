import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  extractLearningPairs,
  learningChatPhoneKey,
  learningChatPhoneKeys,
  rankLearningPairs,
  scrubLearningText,
} = await jiti.import(
  "../lib/chat-learning.ts"
);

function message(body, fromMe, id) {
  return {
    id,
    chatId: "94770000000@c.us",
    body,
    fromMe,
    timestamp: Date.now(),
    senderName: "",
  };
}

test("learning text removes direct contact data and address-like lines", () => {
  assert.equal(
    scrubLearningText("Call me on 0771234567 or mail buyer@example.com"),
    "Call me on [phone] or mail [email]"
  );
  assert.equal(
    scrubLearningText("Address: No. 42, Galle Road, Colombo"),
    "[address shared]"
  );
  assert.equal(scrubLearningText("මේකේ මිල කීයද?"), "මේකේ මිල කීයද?");
  assert.equal(
    scrubLearningText("Nimali, your DC-1001 total is Rs. 2,500", ["Nimali"]),
    "[customer], your [order] total is [amount]"
  );
});

test("learning pairs combine consecutive customer bubbles with the next shop reply", () => {
  const pairs = extractLearningPairs([
    message("Hi", false, "1"),
    message("price eka kiyanna", false, "2"),
    message("Ow, available 😊 Order ekak danna da?", true, "3"),
    message("Address: No 12, Galle Road", false, "4"),
    message("Hari, order eka confirm kala.", true, "5"),
  ]);
  assert.deepEqual(pairs, [
    {
      customer: "Hi price eka kiyanna",
      shop: "Ow, available 😊 Order ekak danna da?",
    },
  ]);
});

test("media-only and unprompted outbound messages are not learned", () => {
  const media = { ...message("[photo]", false, "1"), media: "image" };
  assert.deepEqual(
    extractLearningPairs([
      message("Automated broadcast", true, "0"),
      media,
      message("Can I order?", false, "2"),
      message("Yes, shall I get your city?", true, "3"),
    ]),
    [{ customer: "Can I order?", shop: "Yes, shall I get your city?" }]
  );
});

test("post-purchase tracking and delivery replies are excluded", () => {
  assert.deepEqual(
    extractLearningPairs([
      message("Can you track my parcel?", false, "1"),
      message("Your courier tracking number is DC-1234", true, "2"),
      message("Can I buy one?", false, "3"),
      message("Sure, which city are you in?", true, "4"),
    ]),
    [{ customer: "Can I buy one?", shop: "Sure, which city are you in?" }]
  );
});

test("retrieval prefers similar questions and caps prompt examples", () => {
  const pairs = [
    { customer: "hello", shop: "Hi, how can I help?" },
    { customer: "price eka keeyada?", shop: "Price eka [amount]. Order ekak danna da?" },
    { customer: "is this in stock?", shop: "Yes, it is available." },
    { customer: "delivery fee?", shop: "Tell me your city and I can check." },
  ];
  const ranked = rankLearningPairs("price eka kiyanna", pairs, 2);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].customer, "price eka keeyada?");
});

test("learning resolves modern WhatsApp LIDs through their stored phone mapping", () => {
  assert.equal(
    learningChatPhoneKey("123456789012345@lid", "94771234567"),
    "771234567"
  );
});

test("standard WhatsApp phone JIDs continue to match directly", () => {
  assert.equal(
    learningChatPhoneKey("94771234567@s.whatsapp.net"),
    "771234567"
  );
});

test("LID chats can collect identities from both auth mappings and shared order numbers", () => {
  assert.deepEqual(
    learningChatPhoneKeys("123456789012345@lid", [
      "94771234567",
      "077 987 6543",
      "94771234567",
    ]),
    ["771234567", "779876543"]
  );
});

test("an unresolved LID is never mistaken for a customer phone number", () => {
  assert.deepEqual(learningChatPhoneKeys("123456789012345@lid"), []);
});
