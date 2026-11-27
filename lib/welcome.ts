// Automatic welcome for brand-new customers.
//
// The WhatsApp worker calls /api/whatsapp/inbound after a customer's message
// (debounced so a burst of bubbles is one call). If this is the customer's very
// first contact, the owner's greeting and saved welcome messages go out in
// order, each after a short "typing…" pause — the same thing the owner used to
// do by hand with WhatsApp quick replies.
//
// It never touches the parcel notifications (shipped / out for delivery /
// rescheduled / delivered); those keep their own templates and queue.

import { getChatStateByPhoneKey, getSettings, listAllOrders, queryDatabase, usingSupabase } from "./db";
import { getCustomerProfile, recordCustomerEvent } from "./crm-db";
import { optedOut } from "./followups";
import { chatIdToPhone } from "./phone";
import { phoneKey } from "./risk";
import { markSchemaCurrent, schemaIsCurrent } from "./schema-once";
import { requireTenantSession } from "./tenant-context";
import { signedObjectUrl, storageConfigured } from "./storage";
import { makeTemplates } from "./templates";
import { markChatRead, sendTypingState, sendWhatsAppMessage, workerFetch } from "./wa";
import {
  chooseWelcomeText,
  isFirstContact,
  isFreshInbound,
  isPersonChat,
  typingPauseMs,
  welcomeCapReached,
  welcomeSendPlan,
  type WelcomeHistoryMessage,
  type WelcomeSkipReason,
} from "./welcome-policy";

export interface WelcomeInbound {
  chatId: string;
  timestamp: number;
}

export type WelcomeResult = { sent: number } | { skipped: WelcomeSkipReason };

const g = globalThis as unknown as {
  __welcomeSchemaReady?: Set<string>;
  __welcomeClaims?: Map<string, number>;
};
const memClaims: Map<string, number> = (g.__welcomeClaims ??= new Map());
const schemaDb = { query: queryDatabase };

async function ensureWelcomeSchema(): Promise<void> {
  if (!usingSupabase) return;
  const tenantId = (await requireTenantSession()).tenantId;
  const ready = (g.__welcomeSchemaReady ??= new Set());
  if (ready.has(tenantId)) return;
  if (await schemaIsCurrent(schemaDb, "welcome", ensureWelcomeSchema)) {
    ready.add(tenantId);
    return;
  }
  await queryDatabase(`
    create table if not exists welcome_sends (
      chat_id varchar primary key,
      phone_key varchar(9) not null default '',
      messages int not null default 0,
      created_at timestamptz not null default now()
    );
    create index if not exists idx_welcome_sends_at on welcome_sends(created_at desc);
    -- Which photo goes with which welcome box. Only the Storage file name lives
    -- here; the photo itself is in Supabase Storage, never in the database.
    create table if not exists welcome_photos (
      slot int primary key,
      path varchar not null,
      mime varchar not null default 'image/jpeg',
      updated_at timestamptz not null default now()
    );
  `);
  await markSchemaCurrent(schemaDb, "welcome", ensureWelcomeSchema);
  ready.add(tenantId);
}

// One welcome per chat, ever — enforced by the primary key, so two worker
// calls racing for the same burst cannot both send.
async function claimWelcome(chatId: string, key: string): Promise<boolean> {
  if (!usingSupabase) {
    if (memClaims.has(chatId)) return false;
    memClaims.set(chatId, Date.now());
    return true;
  }
  await ensureWelcomeSchema();
  const { rowCount } = await queryDatabase(
    `insert into welcome_sends (chat_id, phone_key) values ($1, $2)
     on conflict (chat_id) do nothing`,
    [chatId, key]
  );
  return rowCount > 0;
}

// Welcomes started in the last hour and day, for the flood caps.
async function recentWelcomes(): Promise<{ hour: number; day: number }> {
  if (!usingSupabase) {
    const now = Date.now();
    const times = [...memClaims.values()];
    return {
      hour: times.filter((t) => now - t < 3_600_000).length,
      day: times.filter((t) => now - t < 86_400_000).length,
    };
  }
  await ensureWelcomeSchema();
  const { rows } = await queryDatabase<{ hour: number; day: number }>(
    `select count(*) filter (where created_at > now() - interval '1 hour')::int as hour,
            count(*)::int as day
       from welcome_sends where created_at > now() - interval '24 hours'`
  );
  return { hour: rows[0]?.hour ?? 0, day: rows[0]?.day ?? 0 };
}

async function recordWelcomeCount(chatId: string, messages: number): Promise<void> {
  if (!usingSupabase) return;
  await queryDatabase("update welcome_sends set messages = $2 where chat_id = $1", [chatId, messages]);
}

async function hasOrder(key: string): Promise<boolean> {
  if (!usingSupabase) {
    const orders = await listAllOrders();
    return orders.some((o) => phoneKey(o.phone_number) === key || phoneKey(o.phone_2 ?? "") === key);
  }
  const { rows } = await queryDatabase(
    `select 1 from orders
      where right(regexp_replace(phone_number, '\\D', '', 'g'), 9) = $1
         or right(regexp_replace(coalesce(phone_2, ''), '\\D', '', 'g'), 9) = $1
      limit 1`,
    [key]
  );
  return rows.length > 0;
}

// ── Welcome photos (one optional photo per box) ────────────────────────────

export const WELCOME_MEDIA_BUCKET = "welcome-media";

export interface WelcomePhoto {
  slot: number;
  path: string;
  mime: string;
}

const g2 = globalThis as unknown as { __welcomePhotos?: Map<number, WelcomePhoto> };
const memPhotos: Map<number, WelcomePhoto> = (g2.__welcomePhotos ??= new Map());

export async function listWelcomePhotos(): Promise<WelcomePhoto[]> {
  if (!usingSupabase) return [...memPhotos.values()].sort((a, b) => a.slot - b.slot);
  await ensureWelcomeSchema();
  const { rows } = await queryDatabase<{ slot: number; path: string; mime: string }>(
    "select slot, path, mime from welcome_photos order by slot"
  );
  return rows;
}

// Returns the photo it replaced, so the caller can delete the old file.
export async function setWelcomePhoto(photo: WelcomePhoto): Promise<WelcomePhoto | null> {
  if (!usingSupabase) {
    const old = memPhotos.get(photo.slot) ?? null;
    memPhotos.set(photo.slot, photo);
    return old;
  }
  await ensureWelcomeSchema();
  const { rows: old } = await queryDatabase<{ slot: number; path: string; mime: string }>(
    "select slot, path, mime from welcome_photos where slot = $1",
    [photo.slot]
  );
  await queryDatabase(
    `insert into welcome_photos (slot, path, mime) values ($1, $2, $3)
     on conflict (slot) do update set path = excluded.path, mime = excluded.mime, updated_at = now()`,
    [photo.slot, photo.path, photo.mime]
  );
  return old[0] ?? null;
}

export async function clearWelcomePhoto(slot: number): Promise<WelcomePhoto | null> {
  if (!usingSupabase) {
    const old = memPhotos.get(slot) ?? null;
    memPhotos.delete(slot);
    return old;
  }
  await ensureWelcomeSchema();
  const { rows } = await queryDatabase<{ slot: number; path: string; mime: string }>(
    "delete from welcome_photos where slot = $1 returning slot, path, mime",
    [slot]
  );
  return rows[0] ?? null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handleWelcomeInbound(inbound: WelcomeInbound): Promise<WelcomeResult> {
  const { chatId, timestamp } = inbound;
  if (!isPersonChat(chatId)) return { skipped: "not_a_person" };
  if (!isFreshInbound(timestamp, Date.now())) return { skipped: "stale" };

  const settings = await getSettings();
  const boxes = makeTemplates(settings.templates, settings.business_name).welcomeBoxes();
  // Photos only when Storage is set up; otherwise the text still goes out.
  const photos = storageConfigured() ? await listWelcomePhotos() : [];
  if (boxes.every((box) => !box) && photos.length === 0) return { skipped: "no_messages" };

  // A real phone number lets us recognise returning customers; a privacy
  // (@lid) chat has none, so only its message history can tell.
  const key = chatId.endsWith("@lid") ? "" : phoneKey(chatIdToPhone(chatId));
  if (key.length === 9) {
    const [profile, state, ordered] = await Promise.all([
      getCustomerProfile(key),
      getChatStateByPhoneKey(key),
      hasOrder(key),
    ]);
    if (profile && (!profile.ai_enabled || optedOut(profile))) return { skipped: "opted_out" };
    if (ordered || profile?.last_outbound_at || (state && state.state !== "NEW")) {
      return { skipped: "existing_customer" };
    }
  }

  const history = await workerFetch<WelcomeHistoryMessage[]>(
    `/messages/${encodeURIComponent(chatId)}?peek=1`
  );
  if (!isFirstContact(history, timestamp)) return { skipped: "existing_conversation" };

  // This customer's version of each box; versions with links are never sent.
  const texts = boxes.map((box, slot) => (box ? chooseWelcomeText(box, key || chatId, slot) : ""));
  const photoBySlot = new Map(photos.map((p) => [p.slot, p]));
  const plan = welcomeSendPlan(texts, new Set(photoBySlot.keys()));
  if (plan.length === 0) return { skipped: "no_messages" };

  const recent = await recentWelcomes();
  if (welcomeCapReached(recent.hour, recent.day)) return { skipped: "capped" };

  if (!(await claimWelcome(chatId, key))) return { skipped: "already_welcomed" };

  let sent = 0;
  try {
    // Blue ticks first, then a moment of "reading" — the order a person does it.
    await markChatRead(chatId);
    await sleep(1_000 + Math.round(Math.random() * 2_000));
    for (const item of plan) {
      const photo = item.photo ? photoBySlot.get(item.slot) : undefined;
      await sendTypingState(chatId, "composing");
      await sleep(typingPauseMs(item.text) + (photo ? 1_500 : 0));
      // A 5-minute link is all the worker needs; it keeps its own copy.
      const mediaRef = photo
        ? {
            url: await signedObjectUrl(WELCOME_MEDIA_BUCKET, photo.path, 300),
            key: photo.path,
            mime: photo.mime,
          }
        : undefined;
      // The key makes a retried HTTP call safe: the worker answers a repeat
      // without sending the customer a second copy.
      await sendWhatsAppMessage(
        chatId,
        item.text,
        undefined,
        undefined,
        undefined,
        `welcome:${chatId}:${item.slot}`,
        mediaRef
      );
      sent++;
    }
  } finally {
    await sendTypingState(chatId, "paused");
    await recordWelcomeCount(chatId, sent).catch(() => null);
  }

  if (key.length === 9) {
    await recordCustomerEvent({
      phone_key: key,
      chat_id: chatId,
      kind: "message_out",
      source: "system",
      payload: { welcome: true, messages: sent },
    }).catch(() => null);
  }
  return { sent };
}
