import { randomUUID } from "crypto";
import { listOrdersForCrm } from "./db";
import { detectLanguageHeuristic } from "./language";
import {
  groupOrdersByCustomerIdentity,
  normalizeCustomerPhone as phoneKey,
  orderIdentityKeys,
} from "./customer-identity";
import { queryDatabase, usingSupabase } from "./db";
import { workerFetch } from "./wa";
import type {
  CustomerLanguageStyle,
  LearningCandidate,
  LearningConversation,
  LearningReplyPair,
  SalesLearningContext,
  SalesStyleProfile,
  WaChat,
  WaMessage,
} from "./types";

const g = globalThis as unknown as {
  __learningSchemaReady?: boolean;
  __learningConversations?: Map<string, LearningConversation>;
  __salesStyleProfile?: SalesStyleProfile | null;
};

type LearningWaChat = WaChat & {
  identity_phone_users?: string[];
};

const memConversations = (g.__learningConversations ??= new Map<string, LearningConversation>());
if (g.__salesStyleProfile === undefined) g.__salesStyleProfile = null;

const PHONE_RE = /(?<!\d)(?:\+?94[\s-]?|0)?7(?:[\s-]?\d){8}(?!\d)/g;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const ORDER_REF_RE = /\b[A-Z]{1,5}-\d{3,}\b/gi;
const MONEY_RE = /\b(?:rs\.?|lkr)\s*[\d,.]+|\b[\d,.]+\s*(?:rupees?|lkr)\b/gi;
const ADDRESS_HINT_RE =
  /\b(address|addr|road|rd\.?|street|st\.?|lane|mawatha|junction|no\.?\s*\d+)\b/i;
const NON_SALES_RE =
  /\b(tracking|track|waybill|courier|dispatched|out for delivery|delivered|refund|return(?:ed)?|complaint)\b/i;

async function ensureLearningSchema(): Promise<void> {
  if (!usingSupabase || g.__learningSchemaReady) return;
  await queryDatabase(`
    create table if not exists ai_learning_conversations (
      id uuid primary key default gen_random_uuid(),
      phone_key varchar(9) not null unique,
      chat_id varchar not null,
      customer_name varchar not null default '',
      order_nos jsonb not null default '[]'::jsonb,
      products jsonb not null default '[]'::jsonb,
      language_style varchar not null default 'en',
      message_count int not null default 0,
      pairs jsonb not null default '[]'::jsonb,
      search_text text not null default '',
      approved_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index if not exists idx_ai_learning_search
      on ai_learning_conversations using gin (to_tsvector('simple', search_text));
    create table if not exists ai_sales_style_profile (
      id int primary key default 1,
      instructions text not null default '',
      traits jsonb not null default '{}'::jsonb,
      sample_count int not null default 0,
      example_count int not null default 0,
      updated_at timestamptz not null default now()
    );
  `);
  g.__learningSchemaReady = true;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function rowToConversation(row: Record<string, unknown>): LearningConversation {
  return {
    id: String(row.id),
    phone_key: String(row.phone_key),
    chat_id: String(row.chat_id),
    customer_name: String(row.customer_name ?? ""),
    order_nos: asStringArray(row.order_nos),
    products: asStringArray(row.products),
    language_style: String(row.language_style ?? "en") as CustomerLanguageStyle,
    message_count: Number(row.message_count ?? 0),
    pairs: (Array.isArray(row.pairs) ? row.pairs : []) as LearningReplyPair[],
    search_text: String(row.search_text ?? ""),
    approved_at: String(row.approved_at),
    updated_at: String(row.updated_at),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function learningChatPhoneKey(
  chatId: string,
  identityPhoneUser?: string | null
): string {
  const resolved = phoneKey(identityPhoneUser ?? "");
  return resolved.length === 9 ? resolved : phoneKey(chatId);
}

export function learningChatPhoneKeys(
  chatId: string,
  identityPhoneUsers: Array<string | null | undefined> = []
): string[] {
  const resolved = unique(
    identityPhoneUsers
      .map((value) => phoneKey(value ?? ""))
      .filter((key) => key.length === 9)
  );
  const jidKey = phoneKey(chatId);
  if (jidKey.length === 9 && !chatId.endsWith("@lid") && !chatId.endsWith("@hosted.lid")) {
    resolved.push(jidKey);
  }
  return unique(resolved);
}

async function listAvailableChats(): Promise<LearningWaChat[]> {
  if (usingSupabase) {
    try {
      const { rows } = await queryDatabase<{
        jid: string;
        name: string;
        last_message: string;
        last_ts: string | number;
        unread: number;
      }>(
        `select jid, name, last_message, last_ts, unread
         from wa_chats order by last_ts desc`
      );
      const identities = new Map<string, Set<string>>();
      const addIdentity = (jid: string, value: unknown) => {
        const key = phoneKey(String(value ?? ""));
        if (key.length !== 9) return;
        const values = identities.get(jid) ?? new Set<string>();
        values.add(key);
        identities.set(jid, values);
      };

      // Chats already touched by the sales/order workflow have an explicit
      // phone ↔ chat link. Keep this independent from the LID lookup so one
      // legacy table cannot make all discovery fail.
      await queryDatabase<{ chat_id: string; phone_number: string }>(
        "select chat_id, phone_number from chat_states"
      )
        .then(({ rows: states }) => {
          states.forEach((state) => addIdentity(state.chat_id, state.phone_number));
        })
        .catch(() => {});

      // Baileys persists reverse LID mappings as auth keys. Parse them in
      // JavaScript instead of casting/joining JSON in SQL; auth stores from
      // different Baileys versions are then harmless to one another.
      await queryDatabase<{ id: string; data: string }>(
        `select id, data from wa_auth
         where id like 'lid-mapping-%' and right(id, 8) = '_reverse'`
      )
        .then(({ rows: mappings }) => {
          for (const mapping of mappings) {
            const lidUser = mapping.id
              .slice("lid-mapping-".length, -"_reverse".length)
              .split(":")[0];
            let phoneUser = mapping.data;
            try {
              phoneUser = JSON.parse(mapping.data) as string;
            } catch {
              // Some legacy stores wrote the scalar without JSON encoding.
            }
            const jid =
              rows.find((chat) => chat.jid.split("@")[0].split(":")[0] === lidUser)?.jid;
            if (jid) addIdentity(jid, phoneUser);
          }
        })
        .catch(() => {});

      // Historical sales chats commonly contain the contact number supplied
      // for the COD order. This is a deterministic fallback when WhatsApp did
      // not provide/persist a LID reverse mapping.
      await queryDatabase<{ jid: string; body: string }>(
        `select jid, body from wa_messages
         where body like '%07%' or body like '%947%' or body like '%+94%'
         order by ts desc limit 10000`
      )
        .then(({ rows: messages }) => {
          for (const message of messages) {
            for (const match of message.body.matchAll(PHONE_RE)) {
              addIdentity(message.jid, match[0]);
            }
          }
        })
        .catch(() => {});

      return rows.map((row) => ({
        id: row.jid,
        name: row.name,
        lastMessage: row.last_message,
        timestamp: Number(row.last_ts),
        unreadCount: Number(row.unread),
        identity_phone_users: [...(identities.get(row.jid) ?? [])],
      }));
    } catch {
      // Older databases may not have worker persistence yet; try its HTTP API.
    }
  }
  return workerFetch<LearningWaChat[]>("/chats").catch(() => []);
}

async function listStoredMessages(chatId: string): Promise<WaMessage[]> {
  if (usingSupabase) {
    try {
      const { rows } = await queryDatabase<{
        id: string;
        jid: string;
        body: string;
        from_me: boolean;
        ts: string | number;
        sender: string;
        status: number;
        media: string;
      }>(
        `select id, jid, body, from_me, ts, sender, status, media
         from wa_messages where jid=$1 order by ts asc limit 500`,
        [chatId]
      );
      return rows.map((row) => ({
        id: row.id,
        chatId: row.jid,
        body: row.body,
        fromMe: row.from_me,
        timestamp: Number(row.ts),
        senderName: row.sender,
        status: Number(row.status),
        media: row.media || undefined,
      }));
    } catch {
      // Fall through to the worker for in-memory/mock mode or legacy schemas.
    }
  }
  return workerFetch<WaMessage[]>(`/messages/${encodeURIComponent(chatId)}?peek=1`);
}

export function scrubLearningText(raw: string, sensitiveTerms: string[] = []): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  let withoutDirectPii = normalized
    .replace(PHONE_RE, "[phone]")
    .replace(EMAIL_RE, "[email]")
    .replace(URL_RE, "[link]")
    .replace(ORDER_REF_RE, "[order]")
    .replace(MONEY_RE, "[amount]");
  for (const term of unique(sensitiveTerms).sort((a, b) => b.length - a.length)) {
    if (term.length < 3) continue;
    withoutDirectPii = withoutDirectPii.replaceAll(term, "[customer]");
  }
  if (ADDRESS_HINT_RE.test(withoutDirectPii) && /\d/.test(withoutDirectPii)) {
    return "[address shared]";
  }
  return withoutDirectPii.slice(0, 500);
}

export function extractLearningPairs(
  messages: WaMessage[],
  sensitiveTerms: string[] = []
): LearningReplyPair[] {
  const pairs: LearningReplyPair[] = [];
  let customerParts: string[] = [];
  for (const message of messages) {
    if (message.media || !message.body.trim()) continue;
    const clean = scrubLearningText(message.body, sensitiveTerms);
    if (!clean) continue;
    if (!message.fromMe) {
      customerParts.push(clean);
      continue;
    }
    if (customerParts.length === 0) continue;
    const customer = customerParts.join(" ").slice(0, 700);
    customerParts = [];
    if (clean === "[address shared]" || customer === "[address shared]") continue;
    if (NON_SALES_RE.test(customer) || NON_SALES_RE.test(clean)) continue;
    pairs.push({ customer, shop: clean });
  }
  return pairs.slice(-12);
}

function dominantStyle(pairs: LearningReplyPair[]): CustomerLanguageStyle {
  const counts = new Map<CustomerLanguageStyle, number>();
  for (const pair of pairs) {
    const assessment = detectLanguageHeuristic(pair.shop, "auto");
    const style = assessment?.style ?? "en";
    counts.set(style, (counts.get(style) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "en";
}

async function approvedKeys(): Promise<Set<string>> {
  if (usingSupabase) {
    await ensureLearningSchema();
    const { rows } = await queryDatabase<{ phone_key: string }>(
      "select phone_key from ai_learning_conversations"
    );
    return new Set(rows.map((row) => row.phone_key));
  }
  return new Set(memConversations.keys());
}

export async function listLearningCandidates(): Promise<LearningCandidate[]> {
  const [orders, chats, approved] = await Promise.all([
    listOrdersForCrm(),
    listAvailableChats(),
    approvedKeys(),
  ]);
  const chatsByPhone = new Map<string, LearningWaChat>();
  for (const chat of [...chats].sort((a, b) => a.timestamp - b.timestamp)) {
    for (const key of learningChatPhoneKeys(chat.id, chat.identity_phone_users)) {
      chatsByPhone.set(key, chat);
    }
  }
  const deliveredGroups = groupOrdersByCustomerIdentity(
    orders.filter((order) => order.order_status === "delivered")
  );
  const grouped: LearningCandidate[] = [];
  for (const group of deliveredGroups.values()) {
    const sorted = [...group].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const latest = sorted[0];
    const keys = unique(group.flatMap(orderIdentityKeys));
    const matchedKey = keys.find((key) => chatsByPhone.has(key));
    const chat = matchedKey ? chatsByPhone.get(matchedKey) : undefined;
    const key = matchedKey ?? keys[0];
    if (!key || key.length !== 9) continue;
    grouped.push({
      phone_key: key,
      chat_id: chat?.id ?? null,
      customer_name: latest.customer_name,
      order_nos: unique(group.map((order) => order.order_no ?? "")),
      products: unique(
        group.flatMap((order) => [
          order.item_name,
          ...(order.items ?? []).map((item) => item.name),
        ])
      ),
      delivered_at: latest.created_at,
      approved: approved.has(key),
      message_count: null,
    });
  }
  return grouped.sort((a, b) => b.delivered_at.localeCompare(a.delivered_at));
}

export async function listLearningConversations(): Promise<LearningConversation[]> {
  if (usingSupabase) {
    await ensureLearningSchema();
    const { rows } = await queryDatabase(
      "select * from ai_learning_conversations order by approved_at desc"
    );
    return rows.map(rowToConversation);
  }
  return [...memConversations.values()].sort((a, b) => b.approved_at.localeCompare(a.approved_at));
}

async function saveConversation(conversation: LearningConversation): Promise<void> {
  if (usingSupabase) {
    await ensureLearningSchema();
    await queryDatabase(
      `insert into ai_learning_conversations
         (id, phone_key, chat_id, customer_name, order_nos, products, language_style,
          message_count, pairs, search_text, approved_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       on conflict (phone_key) do update set
         chat_id=excluded.chat_id, customer_name=excluded.customer_name,
         order_nos=excluded.order_nos, products=excluded.products,
         language_style=excluded.language_style, message_count=excluded.message_count,
         pairs=excluded.pairs, search_text=excluded.search_text, updated_at=excluded.updated_at`,
      [
        conversation.id,
        conversation.phone_key,
        conversation.chat_id,
        conversation.customer_name,
        JSON.stringify(conversation.order_nos),
        JSON.stringify(conversation.products),
        conversation.language_style,
        conversation.message_count,
        JSON.stringify(conversation.pairs),
        conversation.search_text,
        conversation.approved_at,
      ]
    );
    return;
  }
  memConversations.set(conversation.phone_key, conversation);
}

export async function approveLearningCandidates(phoneKeys: string[]): Promise<{
  approved: number;
  skipped: Array<{ phone_key: string; reason: string }>;
  profile: SalesStyleProfile;
}> {
  const requested = new Set(phoneKeys.map(phoneKey).filter((key) => key.length === 9));
  const candidates = (await listLearningCandidates()).filter((candidate) =>
    requested.has(candidate.phone_key)
  );
  let approved = 0;
  const skipped: Array<{ phone_key: string; reason: string }> = [];
  const processCandidate = async (candidate: LearningCandidate) => {
    if (!candidate.chat_id) {
      skipped.push({ phone_key: candidate.phone_key, reason: "No matching WhatsApp chat" });
      return;
    }
    try {
      const messages = await listStoredMessages(candidate.chat_id);
      const cutoff = new Date(candidate.delivered_at).getTime() + 24 * 60 * 60 * 1000;
      const salesWindow = messages
        .filter((message) => {
          const timestamp =
            message.timestamp < 1_000_000_000_000
              ? message.timestamp * 1000
              : message.timestamp;
          return timestamp <= cutoff;
        })
        .slice(-80);
      const pairs = extractLearningPairs(salesWindow, [candidate.customer_name]);
      if (pairs.length === 0) {
        skipped.push({ phone_key: candidate.phone_key, reason: "No reusable reply pairs" });
        return;
      }
      const now = new Date().toISOString();
      await saveConversation({
        id: randomUUID(),
        phone_key: candidate.phone_key,
        chat_id: candidate.chat_id,
        customer_name: candidate.customer_name,
        order_nos: candidate.order_nos,
        products: candidate.products,
        language_style: dominantStyle(pairs),
        message_count: salesWindow.length,
        pairs,
        search_text: [...candidate.products, ...pairs.flatMap((pair) => [pair.customer, pair.shop])]
          .join(" ")
          .toLowerCase()
          .slice(0, 12_000),
        approved_at: now,
        updated_at: now,
      });
      approved += 1;
    } catch (error) {
      skipped.push({
        phone_key: candidate.phone_key,
        reason: error instanceof Error ? error.message : "Could not read chat",
      });
    }
  };
  for (let index = 0; index < candidates.length; index += 6) {
    await Promise.all(candidates.slice(index, index + 6).map(processCandidate));
  }
  return { approved, skipped, profile: await rebuildSalesStyleProfile() };
}

export async function removeLearningConversation(phoneKeyValue: string): Promise<SalesStyleProfile> {
  const key = phoneKey(phoneKeyValue);
  if (usingSupabase) {
    await ensureLearningSchema();
    await queryDatabase("delete from ai_learning_conversations where phone_key=$1", [key]);
  } else {
    memConversations.delete(key);
  }
  return rebuildSalesStyleProfile();
}

function countEmoji(text: string): number {
  return (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

export async function rebuildSalesStyleProfile(): Promise<SalesStyleProfile> {
  const conversations = await listLearningConversations();
  const pairs = conversations.flatMap((conversation) => conversation.pairs);
  const replies = pairs.map((pair) => pair.shop);
  const wordCounts = replies.map((reply) => reply.split(/\s+/).filter(Boolean).length);
  const averageWords = replies.length
    ? Math.round(wordCounts.reduce((sum, count) => sum + count, 0) / replies.length)
    : 0;
  const questionRate = replies.length
    ? replies.filter((reply) => reply.includes("?")).length / replies.length
    : 0;
  const emojiRate = replies.length
    ? replies.filter((reply) => countEmoji(reply) > 0).length / replies.length
    : 0;
  const languageStyles: Partial<Record<CustomerLanguageStyle, number>> = {};
  for (const conversation of conversations) {
    languageStyles[conversation.language_style] =
      (languageStyles[conversation.language_style] ?? 0) + 1;
  }
  const topStyles = Object.entries(languageStyles)
    .sort((a, b) => b[1] - a[1])
    .map(([style]) => style)
    .slice(0, 3);
  const instructions = pairs.length
    ? [
        `Match the team's concise WhatsApp voice: replies average about ${averageWords} words.`,
        questionRate >= 0.45
          ? "Usually finish with one simple question that moves the sale forward."
          : "Ask a question only when it naturally moves the sale forward.",
        emojiRate >= 0.5
          ? "A single friendly emoji is common; keep it natural."
          : "Use emoji sparingly.",
        topStyles.length ? `Observed writing styles: ${topStyles.join(", ")}.` : "",
        "Copy the rhythm and warmth of approved examples, never their customer details or commercial facts.",
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const profile: SalesStyleProfile = {
    instructions,
    traits: {
      average_words: averageWords,
      question_rate: Number(questionRate.toFixed(2)),
      emoji_rate: Number(emojiRate.toFixed(2)),
      language_styles: languageStyles,
    },
    sample_count: conversations.length,
    example_count: pairs.length,
    updated_at: new Date().toISOString(),
  };
  if (usingSupabase) {
    await ensureLearningSchema();
    await queryDatabase(
      `insert into ai_sales_style_profile
         (id, instructions, traits, sample_count, example_count, updated_at)
       values (1,$1,$2,$3,$4,now())
       on conflict (id) do update set
         instructions=excluded.instructions, traits=excluded.traits,
         sample_count=excluded.sample_count, example_count=excluded.example_count,
         updated_at=now()`,
      [
        profile.instructions,
        JSON.stringify(profile.traits),
        profile.sample_count,
        profile.example_count,
      ]
    );
  } else {
    g.__salesStyleProfile = profile;
  }
  return profile;
}

export async function getSalesStyleProfile(): Promise<SalesStyleProfile | null> {
  if (usingSupabase) {
    await ensureLearningSchema();
    const { rows } = await queryDatabase("select * from ai_sales_style_profile where id=1");
    const row = rows[0];
    if (!row || Number(row.sample_count) === 0) return null;
    return {
      instructions: String(row.instructions),
      traits: row.traits as SalesStyleProfile["traits"],
      sample_count: Number(row.sample_count),
      example_count: Number(row.example_count),
      updated_at: String(row.updated_at),
    };
  }
  return g.__salesStyleProfile ?? null;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length > 1)
      .slice(0, 80)
  );
}

function similarity(query: Set<string>, pair: LearningReplyPair): number {
  const example = tokens(`${pair.customer} ${pair.shop}`);
  let overlap = 0;
  for (const token of query) if (example.has(token)) overlap += 1;
  return overlap / Math.max(4, Math.sqrt(query.size * example.size));
}

export function rankLearningPairs(
  customerMessage: string,
  pairs: LearningReplyPair[],
  limit = 3
): LearningReplyPair[] {
  const query = tokens(customerMessage);
  const queryStyle = detectLanguageHeuristic(customerMessage, "auto")?.style;
  return pairs
    .map((pair, index) => {
      const pairStyle = detectLanguageHeuristic(pair.customer, "auto")?.style;
      const languageBoost = queryStyle && pairStyle === queryStyle ? 0.35 : 0;
      return { pair, score: similarity(query, pair) + languageBoost, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(0, Math.min(5, limit)))
    .map(({ pair }) => pair);
}

export async function getSalesLearningContext(
  customerMessage: string,
  limit = 3
): Promise<SalesLearningContext> {
  const [profile, conversations] = await Promise.all([
    getSalesStyleProfile(),
    listLearningConversations(),
  ]);
  if (!profile || conversations.length === 0) {
    return { style_profile: null, relevant_examples: [] };
  }
  const ranked = rankLearningPairs(
    customerMessage,
    conversations.flatMap((conversation) => conversation.pairs),
    Math.max(1, limit)
  );
  return { style_profile: profile, relevant_examples: ranked };
}
