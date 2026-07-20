// Outbound WhatsApp message templates.
//
// Each template is a plain string with {{placeholders}}. The operator can
// override any of them from the Quest page (stored in business_settings.templates);
// a missing override falls back to the defaults below.
//
// Rendering rules:
//   {{total}}    → COD amount (Rs., digits only)
//   {{tracking}} → courier tracking id
// A line whose placeholders are ALL unresolved is dropped entirely, so e.g.
// the tracking line disappears cleanly when there is no tracking id yet.

import type { AlertKind, MessageTemplates, TemplateKey } from "./types";

export const TEMPLATE_META: Record<
  TemplateKey,
  { label: string; hint: string; placeholders: string[] }
> = {
  askAddress: {
    label: "📍 Ask for address",
    hint: "Sent when you tap “Ask for address” in the chat action bar.",
    placeholders: [],
  },
  codConfirm: {
    label: "💰 COD confirmation",
    hint: "Asks the customer to confirm the order total before booking.",
    placeholders: ["{{total}}"],
  },
  shippedConfirmation: {
    label: "🚚 Shipped confirmation",
    hint: "Drafted after every dispatch — you review it before sending.",
    placeholders: ["{{total}}", "{{tracking}}"],
  },
  trackingAlert: {
    label: "📦 Tracking alert",
    hint: "Quick tracking-number nudge for SHIPPED customers.",
    placeholders: ["{{tracking}}"],
  },
  delayBonus: {
    label: "🎁 Delay apology bonus",
    hint: "Apology + discount offer for delayed deliveries.",
    placeholders: [],
  },
  followUpAddress: {
    label: "🔔 Address reminder",
    hint: "Nudge for chats stuck waiting on an address — sent from the follow-up queue.",
    placeholders: [],
  },
  followUpConfirm: {
    label: "🔔 Confirmation reminder",
    hint: "Nudge for chats that never replied OK to the COD confirmation.",
    placeholders: [],
  },
  outForDelivery: {
    label: "🛵 Out for delivery",
    hint: "Auto-sent when the courier marks the parcel out for delivery.",
    placeholders: ["{{tracking}}"],
  },
  rescheduledDelivery: {
    label: "📅 Rescheduled delivery",
    hint: "Auto-sent when delivery is rescheduled or the courier could not deliver the parcel.",
    placeholders: ["{{tracking}}"],
  },
  deliveredThanks: {
    label: "💚 Delivered thank-you",
    hint: "Auto-sent when the courier confirms delivery.",
    placeholders: [],
  },
  returnedApology: {
    label: "↩️ Return / redeliver offer",
    hint: "Auto-sent when a parcel comes back — asks the customer if they want a redelivery.",
    placeholders: [],
  },
};

export const DEFAULT_TEMPLATES: Record<TemplateKey, string> = {
  askAddress: `ස්තූතියි! 🙏 Order එක process කරන්න මේ විස්තර එවන්න:\n\n1. නම\n2. Address එක (district එකත් එක්ක)\n3. Phone number`,

  codConfirm: `ඔබගේ order එක confirm කරන්නම්ද? 📦\n\nගෙදරටම delivery — ලැබෙනකොට ගෙවන්න (COD).\nමුළු මුදල: රු. {{total}}\n\nOK කියලා reply කරන්න ✅`,

  shippedConfirmation:
    `🌿 *Daily Cart*\n\n` +
    `ආයුබෝවන්! 🙏 ඔබගේ ඇණවුම සාර්ථකව තහවුරු කර, delivery සඳහා යොමු කර ඇත. ✅\n\n` +
    `📦 Tracking අංකය: *{{tracking}}*\n` +
    `💰 ලැබීමේදී ගෙවීමට ඇති මුදල (COD): *රු. {{total}}*\n` +
    `🚚 සාමාන්‍යයෙන් වැඩ කරන දින 1–3ක් ඇතුළත ඔබ වෙත ලැබෙනු ඇත.\n\n` +
    `ඔබගේ ඇණවුමට බොහෝම ස්තූතියි! 💚 ඕනෑම ගැටලුවක් ඇත්නම් මෙම chat එකට reply කරන්න.\n\n` +
    `━━━━━━━━━━━━━━\n` +
    `ⓘ මෙය Daily Cart පද්ධතියෙන් ස්වයංක්‍රීයව (automatically) ජනනය කරන ලද පණිවිඩයකි.`,

  trackingAlert: `ඔබේ පැකේජය courier වෙත භාර දුන්නා 📦\nTracking අංකය: {{tracking}}\nදවස් 1–2ක් ඇතුළත ලැබෙයි!`,

  delayBonus: `Delivery එක ටිකක් delay වුණා, සමාවෙන්න 🙏\nඒ වෙනුවෙන් ඔබේ ඊළඟ order එකට 10% discount එකක් දෙනවා! 🎁`,

  followUpAddress: `පොඩි reminder එකක් 🙏 ඔබගේ order එක process කරන්න මේ විස්තර තාම බලාපොරොත්තුවෙන් ඉන්නවා:\n\n1. නම\n2. Address එක (district එකත් එක්ක)\n3. Phone number\n\nවිස්තර එවපු ගමන් delivery යවන්නම්! 🚚`,

  followUpConfirm: `ඔබගේ order එක confirm කරන්න තාම බලාපොරොත්තුවෙන් ඉන්නවා 😊\nOK කියලා reply කළොත් අදම process කරන්නම් ✅\nප්‍රශ්නයක් තියෙනවා නම් මෙතනින්ම අහන්න!`,

  outForDelivery: `🛵 ඔබගේ පැකේජය අද delivery සඳහා පිටත් වෙලා!\n📦 Tracking: {{tracking}}\nකරුණාකර phone එක ළඟ තියාගන්න — courier ඔබට call කරයි. 📞`,

  rescheduledDelivery: `ඔබගේ පැකේජය අද deliver කිරීමට නොහැකි වූ නිසා නැවත delivery සඳහා reschedule කර ඇත. 🙏\nකරුණාකර phone එක ළඟ තබාගන්න. Courier නැවත ඔබව සම්බන්ධ කරයි. 📞\n📦 Tracking: {{tracking}}`,

  deliveredThanks: `ඔබගේ පැකේජය ලැබුණා! 🎉\nDaily Cart එක්ක order කළාට බොහෝම ස්තූතියි 💚\nමොනවා හරි ප්‍රශ්නයක් තියෙනවා නම් මේ chat එකට reply කරන්න.`,

  returnedApology: `ඔබගේ පැකේජය deliver කරන්න බැරි වුණා 😔\nතවමත් ඕන නම් නැවත යවන්න පුළුවන් — *OK* කියලා reply කරන්න, අපි redeliver කරන්නම්! 🚚`,
};

type Vars = { total?: number; tracking?: string };

// Substitute {{placeholders}}, then drop any line that still contains an
// unresolved one (e.g. no tracking id yet → no tracking line).
export function renderTemplate(source: string, vars: Vars): string {
  const substituted = source
    .replaceAll("{{total}}", vars.total !== undefined ? String(vars.total) : "{{total}}")
    .replaceAll("{{tracking}}", vars.tracking ? vars.tracking : "{{tracking}}");
  return substituted
    .split("\n")
    .filter((line) => !/\{\{(total|tracking)\}\}/.test(line))
    .join("\n");
}

// Build the callable template set, with operator overrides layered over the
// defaults. Call with no argument for pure defaults (offline fallback).
export function makeTemplates(overrides: MessageTemplates = {}) {
  const src = (key: TemplateKey) => overrides[key]?.trim() || DEFAULT_TEMPLATES[key];
  return {
    askAddress: () => renderTemplate(src("askAddress"), {}),
    codConfirm: (totalCod: number) => renderTemplate(src("codConfirm"), { total: totalCod }),
    shippedConfirmation: (totalCod: number, trackingId?: string) =>
      renderTemplate(src("shippedConfirmation"), { total: totalCod, tracking: trackingId }),
    trackingAlert: (trackingId: string) =>
      renderTemplate(src("trackingAlert"), { tracking: trackingId }),
    delayBonus: () => renderTemplate(src("delayBonus"), {}),
    followUpAddress: () => renderTemplate(src("followUpAddress"), {}),
    followUpConfirm: () => renderTemplate(src("followUpConfirm"), {}),
    outForDelivery: (trackingId: string) =>
      renderTemplate(src("outForDelivery"), { tracking: trackingId }),
    rescheduledDelivery: (trackingId: string) =>
      renderTemplate(src("rescheduledDelivery"), { tracking: trackingId }),
    deliveredThanks: () => renderTemplate(src("deliveredThanks"), {}),
    returnedApology: () => renderTemplate(src("returnedApology"), {}),
  };
}

// The customer message for a given tracking alert kind. Shared by the auto
// sweep and the manual "send alert" endpoint so both send identical text.
// (outForDelivery drops its tracking line cleanly when no id is available.)
export function alertBodyFor(
  t: ReturnType<typeof makeTemplates>,
  kind: AlertKind,
  trackingId?: string
): string {
  switch (kind) {
    case "out_for_delivery":
      return t.outForDelivery(trackingId ?? "");
    case "delivered":
      return t.deliveredThanks();
    case "returned":
      return t.returnedApology();
  }
}

// Default-only instance, kept for call sites that haven't loaded settings yet.
export const templates = makeTemplates();
