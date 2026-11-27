// Automatic welcome for brand-new customers.
//
// The WhatsApp worker calls /api/whatsapp/inbound after a customer's message
// (debounced so a burst of bubbles is one call). If this is the customer's very
// first contact, the app answers with a send plan — the owner's greeting and
// saved welcome messages, with their photo albums — and the worker sends it,
// pacing it like a person: read first, "typing…" before each message. The
// worker does the sending because a long welcome outlasts a Vercel function.
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
import { objectUrl, storageConfigured } from "./storage";
import { makeTemplates } from "./templates";
import { workerFetch } from "./wa";
import {
  chooseWelcomeText,
  isFirstContact,
  isFreshInbound,
  isPersonChat,
  WELCOME_PHOTOS_PER_BOX,
  WELCOME_SLOTS,
  welcomeCapReached,
  welcomeSendPlan,
  type WelcomeHistoryMessage,
  type WelcomeSkipReason,
} from "./welcome-policy";

export interface WelcomeInbound {
  chatId: string;
  timestamp: number;
}

// One WhatsApp step for the worker: a text message, or an album whose first
// photo carries the text as its caption.
export interface WelcomeStep {
  text: string;
  media: { url: string; key: string; mime: string }[];
}

export type WelcomeResult = { send: WelcomeStep[] } | { skipped: WelcomeSkipReason };

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
    -- The photos of each welcome box, in album order. Only the Oracle Object
    -- Storage file name lives here; the photo itself never enters the database.
    create table if not exists welcome_media (
      id uuid primary key default gen_random_uuid(),
      slot int not null,
      position int not null default 0,
      object_name varchar not null,
      mime varchar not null default 'image/jpeg',
      created_at timestamptz not null default now()
    );
    create index if not exists idx_welcome_media_slot on welcome_media(slot, position);
    -- Superseded single-photo table (never held a photo: its Storage was blocked).
    drop table if exists welcome_photos;
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

// ── Welcome photos (an album per box) ─────────────────────────────────────

export interface WelcomeMedia {
  id: string;
  slot: number;
  position: number;
  object_name: string;
  mime: string;
}

const g2 = globalThis as unknown as { __welcomeMedia?: Map<string, WelcomeMedia> };
const memMedia: Map<string, WelcomeMedia> = (g2.__welcomeMedia ??= new Map());

export async function listWelcomeMedia(): Promise<WelcomeMedia[]> {
  if (!usingSupabase) {
    return [...memMedia.values()].sort((a, b) => a.slot - b.slot || a.position - b.position);
  }
  await ensureWelcomeSchema();
  const { rows } = await queryDatabase<{
    id: string;
    slot: number;
    position: number;
    object_name: string;
    mime: string;
  }>("select id, slot, position, object_name, mime from welcome_media order by slot, position, created_at");
  return rows;
}

export async function getWelcomeMedia(id: string): Promise<WelcomeMedia | null> {
  return (await listWelcomeMedia()).find((m) => m.id === id) ?? null;
}

// Appends to the end of the box's album. Null when the box is already full.
export async function addWelcomeMedia(input: {
  slot: number;
  object_name: string;
  mime: string;
}): Promise<WelcomeMedia | null> {
  if (input.slot < 0 || input.slot >= WELCOME_SLOTS) return null;
  const current = (await listWelcomeMedia()).filter((m) => m.slot === input.slot);
  if (current.length >= WELCOME_PHOTOS_PER_BOX) return null;
  const position = current.reduce((max, m) => Math.max(max, m.position + 1), 0);
  if (!usingSupabase) {
    const media = { id: crypto.randomUUID(), position, ...input };
    memMedia.set(media.id, media);
    return media;
  }
  const { rows } = await queryDatabase<{
    id: string;
    slot: number;
    position: number;
    object_name: string;
    mime: string;
  }>(
    `insert into welcome_media (slot, position, object_name, mime) values ($1, $2, $3, $4)
     returning id, slot, position, object_name, mime`,
    [input.slot, position, input.object_name, input.mime]
  );
  return rows[0] ?? null;
}

export async function removeWelcomeMedia(id: string): Promise<WelcomeMedia | null> {
  if (!usingSupabase) {
    const old = memMedia.get(id) ?? null;
    memMedia.delete(id);
    return old;
  }
  await ensureWelcomeSchema();
  const { rows } = await queryDatabase<{
    id: string;
    slot: number;
    position: number;
    object_name: string;
    mime: string;
  }>("delete from welcome_media where id = $1 returning id, slot, position, object_name, mime", [id]);
  return rows[0] ?? null;
}

// Moves a photo one place earlier (-1) or later (+1) within its box's album.
export async function moveWelcomeMedia(id: string, direction: -1 | 1): Promise<void> {
  const all = await listWelcomeMedia();
  const target = all.find((m) => m.id === id);
  if (!target) return;
  const album = all.filter((m) => m.slot === target.slot);
  const index = album.findIndex((m) => m.id === id);
  const other = album[index + direction];
  if (!other) return;
  // Renumber the album densely with the two swapped, so equal or gapped
  // positions can never make the order ambiguous.
  const order = album.map((m) => m.id);
  [order[index], order[index + direction]] = [order[index + direction], order[index]];
  if (!usingSupabase) {
    order.forEach((mid, position) => {
      const m = memMedia.get(mid);
      if (m) memMedia.set(mid, { ...m, position });
    });
    return;
  }
  await queryDatabase(
    `update welcome_media w set position = o.position
       from unnest($1::uuid[]) with ordinality as o(id, position)
      where w.id = o.id`,
    [order]
  );
}

export async function handleWelcomeInbound(inbound: WelcomeInbound): Promise<WelcomeResult> {
  const { chatId, timestamp } = inbound;
  if (!isPersonChat(chatId)) return { skipped: "not_a_person" };
  if (!isFreshInbound(timestamp, Date.now())) return { skipped: "stale" };

  const settings = await getSettings();
  const boxes = makeTemplates(settings.templates, settings.business_name).welcomeBoxes();
  // Photos only when Storage is set up; otherwise the text still goes out.
  const media = storageConfigured() ? await listWelcomeMedia() : [];
  if (boxes.every((box) => !box) && media.length === 0) return { skipped: "no_messages" };

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
  const albums = Array.from({ length: WELCOME_SLOTS }, (_, slot) => media.filter((m) => m.slot === slot));
  const plan = welcomeSendPlan(texts, albums.map((album) => album.length));
  if (plan.length === 0) return { skipped: "no_messages" };

  const recent = await recentWelcomes();
  if (welcomeCapReached(recent.hour, recent.day)) return { skipped: "capped" };

  if (!(await claimWelcome(chatId, key))) return { skipped: "already_welcomed" };

  const send: WelcomeStep[] = plan.map((item) => ({
    text: item.text,
    media: albums[item.slot].slice(0, item.photos).map((m) => ({
      url: objectUrl(m.object_name),
      // A new name per upload, so the worker's disk cache can never serve a
      // replaced photo.
      key: m.object_name,
      mime: m.mime,
    })),
  }));
  const messages = send.reduce((n, step) => n + Math.max(1, step.media.length), 0);
  await recordWelcomeCount(chatId, messages).catch(() => null);

  if (key.length === 9) {
    await recordCustomerEvent({
      phone_key: key,
      chat_id: chatId,
      kind: "message_out",
      source: "system",
      payload: { welcome: true, messages },
    }).catch(() => null);
  }
  return { send };
}
