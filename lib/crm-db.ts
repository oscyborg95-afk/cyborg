import { randomUUID } from "crypto";
import { queryDatabase, usingSupabase, withTransaction } from "./db";
import { markSchemaCurrent, schemaIsCurrent } from "./schema-once";
import { requireTenantSession } from "./tenant-context.ts";
import type {
  AttentionItem,
  AttentionKind,
  AttentionPriority,
  AttentionStatus,
  CustomerEvent,
  CustomerEventKind,
  CustomerLanguage,
  CustomerProfile,
} from "./types";

const g = globalThis as unknown as {
  __crmSchemaReady?: Set<string>;
  __customerProfiles?: Map<string, CustomerProfile>;
  __customerEvents?: CustomerEvent[];
  __attentionItems?: Map<string, AttentionItem>;
};

const memProfiles: Map<string, CustomerProfile> = (g.__customerProfiles ??= new Map());
const memEvents: CustomerEvent[] = (g.__customerEvents ??= []);
const memAttention: Map<string, AttentionItem> = (g.__attentionItems ??= new Map());

export interface PurgedCustomerData {
  profiles: number;
  events: number;
  attentionItems: number;
  agentRuns: number;
  leadMemories: number;
}

const schemaDb = { query: queryDatabase };

async function ensureCrmSchema(): Promise<void> {
  if (!usingSupabase) return;
  const tenantId = (await requireTenantSession()).tenantId;
  const ready = (g.__crmSchemaReady ??= new Set());
  if (ready.has(tenantId)) return;
  if (await schemaIsCurrent(schemaDb, "crm", ensureCrmSchema)) {
    ready.add(tenantId);
    return;
  }
  await queryDatabase(`
    create table if not exists customer_profiles (
      phone_key varchar(9) primary key,
      primary_phone varchar not null,
      display_name varchar not null default '',
      preferred_language varchar not null default 'auto',
      tags jsonb not null default '[]'::jsonb,
      notes text not null default '',
      ai_enabled boolean not null default true,
      ai_paused_until timestamptz,
      last_inbound_at timestamptz,
      last_outbound_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    alter table customer_profiles
      add column if not exists language_locked boolean not null default false;
    create table if not exists customer_events (
      id uuid primary key default gen_random_uuid(),
      phone_key varchar(9) not null,
      chat_id varchar,
      kind varchar not null,
      source varchar not null,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create index if not exists idx_customer_events_phone
      on customer_events(phone_key, created_at desc);
    create table if not exists attention_items (
      id uuid primary key default gen_random_uuid(),
      unique_key varchar not null unique,
      phone_key varchar(9) not null,
      chat_id varchar,
      kind varchar not null,
      priority varchar not null default 'medium',
      title varchar not null,
      summary text not null default '',
      status varchar not null default 'open',
      due_at timestamptz,
      snoozed_until timestamptz,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      resolved_at timestamptz
    );
    create index if not exists idx_attention_open
      on attention_items(status, priority, updated_at desc);
    create table if not exists ai_agent_config (
      id int primary key default 1,
      mode varchar not null default 'draft',
      min_confidence numeric not null default 0.78,
      reply_delay_seconds int not null default 6,
      business_context text not null default '',
      personality text not null default
        'Warm, concise, helpful Sri Lankan ecommerce salesperson. Never pressure the customer.',
      quiet_hours_start varchar not null default '22:00',
      quiet_hours_end varchar not null default '07:00',
      updated_at timestamptz not null default now()
    );
    insert into ai_agent_config (id) values (1) on conflict do nothing;
    create table if not exists ai_agent_runs (
      id uuid primary key default gen_random_uuid(),
      trigger_message_id varchar not null unique,
      phone_key varchar(9) not null,
      chat_id varchar not null,
      intent varchar,
      language varchar,
      confidence numeric not null default 0,
      decision jsonb,
      reply text not null default '',
      status varchar not null default 'processing',
      error text not null default '',
      created_at timestamptz not null default now(),
      completed_at timestamptz
    );
    alter table ai_agent_runs
      add column if not exists feedback_status varchar not null default 'none',
      add column if not exists feedback_reason text not null default '',
      add column if not exists final_reply text not null default '',
      add column if not exists reviewed_at timestamptz;
    create index if not exists idx_ai_agent_runs_phone
      on ai_agent_runs(phone_key, created_at desc);
    create table if not exists ai_lead_memory (
      phone_key varchar(9) primary key,
      detected_language varchar,
      language_style varchar,
      language_confidence numeric not null default 0,
      language_observations int not null default 0,
      interested_product varchar not null default '',
      quantity int,
      customer_need text not null default '',
      objection text not null default '',
      buying_intent varchar not null default 'low',
      collected_fields jsonb not null default '[]'::jsonb,
      last_question text not null default '',
      next_action text not null default '',
      updated_at timestamptz not null default now()
    );
  `);
  await markSchemaCurrent(schemaDb, "crm", ensureCrmSchema);
  ready.add(tenantId);
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function purgeCustomerData(
  phoneKey: string,
  chatId: string
): Promise<PurgedCustomerData> {
  if (usingSupabase) {
    await ensureCrmSchema();
    return withTransaction(async (db) => {
      if (!db) throw new Error("Database transaction unavailable");
      const agentRuns = await db.query(
        "delete from ai_agent_runs where phone_key=$1 or chat_id=$2",
        [phoneKey, chatId]
      );
      const attentionItems = await db.query(
        "delete from attention_items where phone_key=$1 or chat_id=$2",
        [phoneKey, chatId]
      );
      const events = await db.query(
        "delete from customer_events where phone_key=$1 or chat_id=$2",
        [phoneKey, chatId]
      );
      const leadMemories = await db.query(
        "delete from ai_lead_memory where phone_key=$1",
        [phoneKey]
      );
      // Left over from the retired AI salesperson's "learn my style" feature:
      // still the customer's conversation text, so it goes with the chat.
      const learning = await db.query("select to_regclass('ai_learning_conversations') is not null as ok");
      if (learning.rows[0]?.ok) {
        await db.query("delete from ai_learning_conversations where phone_key=$1", [phoneKey]);
      }
      const profiles = await db.query(
        "delete from customer_profiles where phone_key=$1",
        [phoneKey]
      );
      return {
        profiles: profiles.rowCount ?? 0,
        events: events.rowCount ?? 0,
        attentionItems: attentionItems.rowCount ?? 0,
        agentRuns: agentRuns.rowCount ?? 0,
        leadMemories: leadMemories.rowCount ?? 0,
      };
    });
  }

  const profiles = Number(memProfiles.delete(phoneKey));
  let events = 0;
  for (let index = memEvents.length - 1; index >= 0; index -= 1) {
    const event = memEvents[index];
    if (event.phone_key !== phoneKey && event.chat_id !== chatId) continue;
    memEvents.splice(index, 1);
    events += 1;
  }
  let attentionItems = 0;
  for (const [key, item] of memAttention) {
    if (item.phone_key !== phoneKey && item.chat_id !== chatId) continue;
    memAttention.delete(key);
    attentionItems += 1;
  }
  return { profiles, events, attentionItems, agentRuns: 0, leadMemories: 0 };
}

export async function ensureCustomerProfile(input: {
  phone_key: string;
  primary_phone: string;
  display_name?: string;
  direction?: "inbound" | "outbound";
  occurred_at?: string;
}): Promise<CustomerProfile> {
  const occurredAt = input.occurred_at ?? nowIso();
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `insert into customer_profiles
         (phone_key, primary_phone, display_name, last_inbound_at, last_outbound_at)
       values ($1,$2,$3,$4,$5)
       on conflict (phone_key) do update set
         primary_phone = excluded.primary_phone,
         display_name = case when excluded.display_name <> '' then excluded.display_name
                             else customer_profiles.display_name end,
         last_inbound_at = coalesce(excluded.last_inbound_at, customer_profiles.last_inbound_at),
         last_outbound_at = coalesce(excluded.last_outbound_at, customer_profiles.last_outbound_at),
         updated_at = now()
       returning *`,
      [
        input.phone_key,
        input.primary_phone,
        input.display_name?.trim() ?? "",
        input.direction === "inbound" ? occurredAt : null,
        input.direction === "outbound" ? occurredAt : null,
      ]
    );
    return rows[0] as unknown as CustomerProfile;
  }

  const existing = memProfiles.get(input.phone_key);
  const profile: CustomerProfile = {
    phone_key: input.phone_key,
    primary_phone: input.primary_phone,
    display_name: input.display_name?.trim() || existing?.display_name || "",
    preferred_language: existing?.preferred_language ?? "auto",
    language_locked: existing?.language_locked ?? false,
    tags: existing?.tags ?? [],
    notes: existing?.notes ?? "",
    ai_enabled: existing?.ai_enabled ?? true,
    ai_paused_until: existing?.ai_paused_until ?? null,
    last_inbound_at:
      input.direction === "inbound" ? occurredAt : (existing?.last_inbound_at ?? null),
    last_outbound_at:
      input.direction === "outbound" ? occurredAt : (existing?.last_outbound_at ?? null),
    created_at: existing?.created_at ?? occurredAt,
    updated_at: occurredAt,
  };
  memProfiles.set(input.phone_key, profile);
  return profile;
}

export async function listCustomerProfiles(): Promise<CustomerProfile[]> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      "select * from customer_profiles order by coalesce(last_inbound_at, updated_at) desc"
    );
    return rows as unknown as CustomerProfile[];
  }
  return [...memProfiles.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function getCustomerProfile(phoneKey: string): Promise<CustomerProfile | null> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      "select * from customer_profiles where phone_key = $1",
      [phoneKey]
    );
    return (rows[0] as unknown as CustomerProfile | undefined) ?? null;
  }
  return memProfiles.get(phoneKey) ?? null;
}

export async function updateCustomerProfile(
  phoneKey: string,
  input: Partial<
    Pick<
      CustomerProfile,
      "display_name" | "preferred_language" | "language_locked" | "tags" | "notes" | "ai_enabled" | "ai_paused_until"
    >
  >
): Promise<CustomerProfile> {
  const current =
    (await getCustomerProfile(phoneKey)) ??
    (await ensureCustomerProfile({ phone_key: phoneKey, primary_phone: phoneKey }));
  const next: CustomerProfile = {
    ...current,
    ...input,
    tags: input.tags ?? current.tags,
    updated_at: nowIso(),
  };
  if (usingSupabase) {
    const { rows } = await queryDatabase(
      `update customer_profiles set
         display_name=$2, preferred_language=$3, language_locked=$4, tags=$5, notes=$6,
         ai_enabled=$7, ai_paused_until=$8, updated_at=now()
       where phone_key=$1 returning *`,
      [
        phoneKey,
        next.display_name,
        next.preferred_language,
        next.language_locked,
        JSON.stringify(next.tags),
        next.notes,
        next.ai_enabled,
        next.ai_paused_until,
      ]
    );
    return rows[0] as unknown as CustomerProfile;
  }
  memProfiles.set(phoneKey, next);
  return next;
}

export async function recordCustomerEvent(input: {
  phone_key: string;
  chat_id?: string | null;
  kind: CustomerEventKind;
  source: CustomerEvent["source"];
  payload?: Record<string, unknown>;
}): Promise<CustomerEvent> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `insert into customer_events (phone_key, chat_id, kind, source, payload)
       values ($1,$2,$3,$4,$5) returning *`,
      [
        input.phone_key,
        input.chat_id ?? null,
        input.kind,
        input.source,
        JSON.stringify(input.payload ?? {}),
      ]
    );
    return rows[0] as unknown as CustomerEvent;
  }
  const event: CustomerEvent = {
    id: randomUUID(),
    phone_key: input.phone_key,
    chat_id: input.chat_id ?? null,
    kind: input.kind,
    source: input.source,
    payload: input.payload ?? {},
    created_at: nowIso(),
  };
  memEvents.push(event);
  return event;
}

export async function listCustomerEvents(phoneKey: string, limit = 100): Promise<CustomerEvent[]> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `select * from customer_events where phone_key=$1
       order by created_at desc limit $2`,
      [phoneKey, limit]
    );
    return rows as unknown as CustomerEvent[];
  }
  return memEvents
    .filter((event) => event.phone_key === phoneKey)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export async function upsertAttention(input: {
  unique_key: string;
  phone_key: string;
  chat_id?: string | null;
  kind: AttentionKind;
  priority: AttentionPriority;
  title: string;
  summary?: string;
  due_at?: string | null;
  payload?: Record<string, unknown>;
}): Promise<AttentionItem> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `insert into attention_items
         (unique_key, phone_key, chat_id, kind, priority, title, summary, due_at, payload)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (unique_key) do update set
         chat_id=excluded.chat_id, kind=excluded.kind, priority=excluded.priority,
         title=excluded.title, summary=excluded.summary, due_at=excluded.due_at,
         payload=excluded.payload,
         status=case
           when attention_items.status='resolved' then 'resolved'
           when attention_items.status='snoozed'
             and attention_items.snoozed_until > now() then 'snoozed'
           else 'open'
         end,
         updated_at=now()
       returning *`,
      [
        input.unique_key,
        input.phone_key,
        input.chat_id ?? null,
        input.kind,
        input.priority,
        input.title,
        input.summary ?? "",
        input.due_at ?? null,
        JSON.stringify(input.payload ?? {}),
      ]
    );
    return rows[0] as unknown as AttentionItem;
  }
  const old = memAttention.get(input.unique_key);
  const now = nowIso();
  const item: AttentionItem = {
    id: old?.id ?? randomUUID(),
    unique_key: input.unique_key,
    phone_key: input.phone_key,
    chat_id: input.chat_id ?? null,
    kind: input.kind,
    priority: input.priority,
    title: input.title,
    summary: input.summary ?? "",
    status:
      old?.status === "resolved"
        ? "resolved"
        : old?.status === "snoozed" &&
            old.snoozed_until &&
            new Date(old.snoozed_until).getTime() > Date.now()
          ? "snoozed"
          : "open",
    due_at: input.due_at ?? null,
    snoozed_until: old?.snoozed_until ?? null,
    payload: input.payload ?? {},
    created_at: old?.created_at ?? now,
    updated_at: now,
    resolved_at: old?.resolved_at ?? null,
  };
  memAttention.set(input.unique_key, item);
  return item;
}

export async function reconcileDerivedAttention(
  activeUniqueKeys: string[],
  kinds: AttentionKind[]
): Promise<number> {
  const active = new Set(activeUniqueKeys);
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rowCount } = await queryDatabase(
      `update attention_items
       set status='resolved', resolved_at=now(), updated_at=now()
       where kind = any($1::varchar[])
         and status in ('open', 'snoozed')
         and not (unique_key = any($2::varchar[]))`,
      [kinds, activeUniqueKeys]
    );
    return rowCount ?? 0;
  }
  let resolved = 0;
  for (const [key, item] of memAttention) {
    if (!kinds.includes(item.kind) || !["open", "snoozed"].includes(item.status) || active.has(key)) continue;
    memAttention.set(key, {
      ...item,
      status: "resolved",
      resolved_at: nowIso(),
      updated_at: nowIso(),
    });
    resolved++;
  }
  return resolved;
}

export async function listAttention(status?: AttentionStatus): Promise<AttentionItem[]> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `select * from attention_items
       where ($1::varchar is null or status=$1)
       order by
         case priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
         updated_at desc`,
      [status ?? null]
    );
    return rows as unknown as AttentionItem[];
  }
  return [...memAttention.values()]
    .filter((item) => !status || item.status === status)
    .sort((a, b) => {
      const rank = { urgent: 0, high: 1, medium: 2, low: 3 };
      return rank[a.priority] - rank[b.priority] || b.updated_at.localeCompare(a.updated_at);
    });
}

export async function updateAttention(
  id: string,
  status: AttentionStatus,
  snoozedUntil: string | null = null
): Promise<AttentionItem | null> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `update attention_items set status=$2, snoozed_until=$3,
         resolved_at=case when $2='resolved' then now() else null end,
         updated_at=now()
       where id=$1 returning *`,
      [id, status, snoozedUntil]
    );
    return (rows[0] as unknown as AttentionItem | undefined) ?? null;
  }
  const entry = [...memAttention.entries()].find(([, item]) => item.id === id);
  if (!entry) return null;
  const [key, item] = entry;
  const next: AttentionItem = {
    ...item,
    status,
    snoozed_until: snoozedUntil,
    resolved_at: status === "resolved" ? nowIso() : null,
    updated_at: nowIso(),
  };
  memAttention.set(key, next);
  return next;
}

export async function resolveAttentionByUniqueKey(uniqueKey: string): Promise<void> {
  if (usingSupabase) {
    await ensureCrmSchema();
    await queryDatabase(
      `update attention_items set status='resolved', resolved_at=now(), updated_at=now()
       where unique_key=$1 and status <> 'resolved'`,
      [uniqueKey]
    );
    return;
  }
  const item = memAttention.get(uniqueKey);
  if (!item || item.status === "resolved") return;
  memAttention.set(uniqueKey, {
    ...item,
    status: "resolved",
    resolved_at: nowIso(),
    updated_at: nowIso(),
  });
}

export function sanitizeLanguage(value: unknown): CustomerLanguage {
  return value === "si" || value === "ta" || value === "en" ? value : "auto";
}
