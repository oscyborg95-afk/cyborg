import assert from "node:assert/strict";
import test from "node:test";
import { makeTemplates } from "../lib/templates.ts";
import {
  FIRST_CONTACT_BURST_MS,
  isFirstContact,
  isFreshInbound,
  isPersonChat,
  typingPauseMs,
} from "../lib/welcome-policy.ts";

const NOW = Date.UTC(2026, 10, 25, 22, 0, 0);

test("welcome is off until the owner fills a box", () => {
  assert.deepEqual(makeTemplates({}).welcomeMessages(), []);
  assert.deepEqual(makeTemplates({ welcome1: "   " }).welcomeMessages(), []);
});

test("welcome sends only filled boxes, greeting first, in order", () => {
  const t = makeTemplates(
    { welcome3: "third", welcomeGreeting: "Hi dear 😊", welcome1: "Welcome to {{business}}" },
    "Daily Cart"
  );
  assert.deepEqual(t.welcomeMessages(), ["Hi dear 😊", "Welcome to Daily Cart", "third"]);
});

test("adding welcome boxes leaves the parcel notifications unchanged", () => {
  const before = makeTemplates({}, "Daily Cart");
  const after = makeTemplates({ welcomeGreeting: "Hi" }, "Daily Cart");
  assert.equal(after.deliveredThanks(), before.deliveredThanks());
  assert.equal(after.rescheduledDelivery("TX1"), before.rescheduledDelivery("TX1"));
  assert.equal(after.outForDelivery("TX1"), before.outForDelivery("TX1"));
});

test("a brand-new chat with only the customer's burst is first contact", () => {
  const history = [
    { fromMe: false, timestamp: NOW },
    { fromMe: false, timestamp: NOW + 4_000 },
  ];
  assert.equal(isFirstContact(history, NOW), true);
  assert.equal(isFirstContact([], NOW), true);
});

test("any message from us means it is not a new customer", () => {
  assert.equal(
    isFirstContact([{ fromMe: true, timestamp: NOW - 1_000 }, { fromMe: false, timestamp: NOW }], NOW),
    false
  );
});

test("an older message from the customer means a returning customer", () => {
  assert.equal(
    isFirstContact(
      [{ fromMe: false, timestamp: NOW - FIRST_CONTACT_BURST_MS - 1 }, { fromMe: false, timestamp: NOW }],
      NOW
    ),
    false
  );
});

test("messages delivered late after a reconnect never trigger a welcome", () => {
  assert.equal(isFreshInbound(NOW - 60_000, NOW), true);
  assert.equal(isFreshInbound(NOW - 11 * 60_000, NOW), false);
  assert.equal(isFreshInbound(Number.NaN, NOW), false);
});

test("only one-to-one chats qualify", () => {
  assert.equal(isPersonChat("94771234567@s.whatsapp.net"), true);
  assert.equal(isPersonChat("94771234567@c.us"), true);
  assert.equal(isPersonChat("12345@lid"), true);
  assert.equal(isPersonChat("1203630@g.us"), false);
  assert.equal(isPersonChat("status@broadcast"), false);
});

test("typing pause stays short and human", () => {
  assert.ok(typingPauseMs("Hi", () => 0) >= 1_500);
  assert.ok(typingPauseMs("x".repeat(5_000), () => 1) <= 6_600);
});

import {
  WELCOME_DAILY_CAP,
  WELCOME_HOURLY_CAP,
  chooseWelcomeText,
  hasLink,
  splitVariants,
  welcomeCapReached,
} from "../lib/welcome-policy.ts";

test("a box can hold several versions separated by ---", () => {
  assert.deepEqual(splitVariants("Version A\n---\nVersion B\n  ---  \nVersion C"), [
    "Version A",
    "Version B",
    "Version C",
  ]);
  assert.deepEqual(splitVariants("Price — Rs. 2500 --- fixed"), ["Price — Rs. 2500 --- fixed"]);
});

test("different customers get different versions, the same customer always the same", () => {
  const box = "A\n---\nB\n---\nC";
  const picks = new Set();
  for (let i = 0; i < 40; i++) picks.add(chooseWelcomeText(box, `7712345${String(i).padStart(2, "0")}`, 1));
  assert.ok(picks.size > 1);
  assert.equal(chooseWelcomeText(box, "771234567", 1), chooseWelcomeText(box, "771234567", 1));
});

test("versions with links are never sent", () => {
  assert.equal(hasLink("see https://dailycart.lk"), true);
  assert.equal(hasLink("order at dailycart.lk"), true);
  assert.equal(hasLink("chat wa.me/9477"), true);
  assert.equal(hasLink("Rs. 2,500.00 COD ✅"), false);
  assert.equal(chooseWelcomeText("Visit www.shop.com", "771234567", 0), "");
  assert.equal(chooseWelcomeText("Visit www.shop.com\n---\nNo link here", "771234567", 0), "No link here");
});

test("welcome flood caps", () => {
  assert.equal(welcomeCapReached(0, 0), false);
  assert.equal(welcomeCapReached(WELCOME_HOURLY_CAP, 0), true);
  assert.equal(welcomeCapReached(0, WELCOME_DAILY_CAP), true);
  assert.equal(welcomeCapReached(WELCOME_HOURLY_CAP - 1, WELCOME_DAILY_CAP - 1), false);
});

import { WELCOME_SLOTS, welcomeSendPlan } from "../lib/welcome-policy.ts";

test("a box goes out when it has text or a photo, in box order", () => {
  assert.equal(WELCOME_SLOTS, 4);
  assert.deepEqual(welcomeSendPlan(["Hi dear", "", "Price list", ""], new Set([1, 2])), [
    { slot: 0, text: "Hi dear", photo: false },
    { slot: 1, text: "", photo: true },
    { slot: 2, text: "Price list", photo: true },
  ]);
  assert.deepEqual(welcomeSendPlan(["", "", "", ""], new Set()), []);
});

test("welcomeBoxes keeps blank boxes so photos stay on the right box", () => {
  const boxes = makeTemplates({ welcome2: "two" }).welcomeBoxes();
  assert.deepEqual(boxes, ["", "", "two", ""]);
});
