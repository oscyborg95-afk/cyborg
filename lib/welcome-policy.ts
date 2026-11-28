// Pure rules for the automatic welcome a brand-new customer receives. Kept free
// of I/O so the "who counts as new" decision is unit-tested on its own.

// A customer's first message often arrives as a burst of bubbles ("hi",
// "price?", a photo). Inbound messages this close to the triggering one still
// count as the same first contact.
export const FIRST_CONTACT_BURST_MS = 15 * 60_000;

// After a reconnect WhatsApp can deliver messages that are hours old. A
// welcome to someone who wrote last night and has since been answered by hand
// would be wrong, so only a message this recent can trigger one.
export const MAX_INBOUND_AGE_MS = 10 * 60_000;

export interface WelcomeHistoryMessage {
  fromMe: boolean;
  timestamp: number;
}

export type WelcomeSkipReason =
  | "no_messages"
  | "stale"
  | "not_a_person"
  | "existing_conversation"
  | "existing_customer"
  | "opted_out"
  | "already_welcomed"
  | "capped"
  | "unknown_number";

export function isFreshInbound(timestamp: number, now: number): boolean {
  return Number.isFinite(timestamp) && now - timestamp <= MAX_INBOUND_AGE_MS;
}

// The phone chat id the worker sends for a privacy-ID (@lid) chat.
export function validPhoneChatId(value: unknown): string | null {
  return typeof value === "string" && /^\d{8,15}@s\.whatsapp\.net$/.test(value) ? value : null;
}

// Only one-to-one chats with a real phone number get a welcome. Groups,
// broadcasts and newsletters never reach here, but the check is cheap.
export function isPersonChat(chatId: string): boolean {
  return /@(s\.whatsapp\.net|c\.us|lid)$/.test(chatId);
}

// True when the chat shows nothing but this first burst from the customer:
// no message from us ever, and no customer message older than the burst.
export function isFirstContact(history: WelcomeHistoryMessage[], inboundAt: number): boolean {
  const burstStart = inboundAt - FIRST_CONTACT_BURST_MS;
  return history.every((m) => !m.fromMe && m.timestamp >= burstStart);
}

// A short human-looking pause before each message, longer for longer text.
export function typingPauseMs(text: string, random: () => number = Math.random): number {
  const base = 1_500 + Math.min(text.length, 300) * 12;
  return Math.round(base + random() * 1_500);
}

// Ban safety: a bug, or a viral ad, must never turn the welcome into a flood.
// Past these, new customers simply wait for the owner to reply by hand.
export const WELCOME_HOURLY_CAP = 20;
export const WELCOME_DAILY_CAP = 100;

export function welcomeCapReached(lastHour: number, lastDay: number): boolean {
  return lastHour >= WELCOME_HOURLY_CAP || lastDay >= WELCOME_DAILY_CAP;
}

// One box can hold several versions of the same message, separated by a line
// containing only "---". Customers get different versions, so hundreds of
// people never receive byte-identical text.
export function splitVariants(text: string): string[] {
  return text
    .split(/^\s*---\s*$/m)
    .map((v) => v.trim())
    .filter(Boolean);
}

// Links in automated messages from an unofficial client are a common spam
// signal, so a version containing one is never sent automatically.
const LINK = /(https?:\/\/|www\.|wa\.me\/|\b[a-z0-9-]+\.(com|lk|net|org|io|me|ly|co|shop|store|link)\b)/i;
export function hasLink(text: string): boolean {
  return LINK.test(text);
}

// Picks this customer's version of one welcome box, or "" when every version
// has a link. Stable per customer, so a retry sends the same text.
export function chooseWelcomeText(box: string, customerKey: string, index: number): string {
  const usable = splitVariants(box).filter((v) => !hasLink(v));
  if (usable.length === 0) return "";
  let hash = 7;
  for (const char of `${customerKey}:welcome:${index}`) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return usable[hash % usable.length];
}

// Greeting + 3 messages; each box can carry a set of photos, which WhatsApp
// shows the customer as one album (a swipeable grid).
export const WELCOME_SLOTS = 4;
export const WELCOME_PHOTOS_PER_BOX = 10;
// Across the whole welcome. A first-time customer who asked one question does
// not need 40 photos, and a big burst of media is what spam looks like.
export const WELCOME_PHOTOS_TOTAL = 20;
// The editor shrinks photos to well under this before uploading.
export const WELCOME_PHOTO_MAX_BYTES = 2 * 1024 * 1024;

export interface WelcomePlanItem {
  slot: number;
  text: string;
  photos: number;
}

// Which boxes actually go out, in order, and how many of each box's photos.
// A box goes out when it has text (after the link guard) or photos; photo
// counts are clipped to the per-box and whole-welcome limits.
export function welcomeSendPlan(texts: string[], photoCounts: number[]): WelcomePlanItem[] {
  const plan: WelcomePlanItem[] = [];
  let photoBudget = WELCOME_PHOTOS_TOTAL;
  for (let slot = 0; slot < WELCOME_SLOTS; slot++) {
    const text = texts[slot] ?? "";
    const photos = Math.max(0, Math.min(photoCounts[slot] ?? 0, WELCOME_PHOTOS_PER_BOX, photoBudget));
    photoBudget -= photos;
    if (text || photos > 0) plan.push({ slot, text, photos });
  }
  return plan;
}
