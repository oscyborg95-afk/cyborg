import { randomUUID } from "crypto";
import { queryDatabase, usingSupabase, withTransaction } from "./db";
import { requireTenantSession } from "./tenant-context.ts";
import type {
  AgentConfig,
  AgentDecision,
  AgentRun,
  AgentRunStatus,
  AttentionItem,
  AttentionKind,
  AttentionPriority,
  AttentionStatus,
  CustomerEvent,
  CustomerEventKind,
  CustomerLanguage,
  CustomerProfile,
  LeadMemory,
} from "./types";

const g = globalThis as unknown as {
  __crmSchemaReady?: Set<string>;
  __customerProfiles?: Map<string, CustomerProfile>;
  __customerEvents?: CustomerEvent[];
  __attentionItems?: Map<string, AttentionItem>;
  __agentConfig?: AgentConfig;
  __agentRuns?: Map<string, AgentRun>;
  __leadMemories?: Map<string, LeadMemory>;
};

const memProfiles: Map<string, CustomerProfile> = (g.__customerProfiles ??= new Map());
const memEvents: CustomerEvent[] = (g.__customerEvents ??= []);
const memAttention: Map<string, AttentionItem> = (g.__attentionItems ??= new Map());
const memRuns: Map<string, AgentRun> = (g.__agentRuns ??= new Map());
const memLeadMemories: Map<string, LeadMemory> = (g.__leadMemories ??= new Map());

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  mode: "draft",
  min_confidence: 0.78,
  reply_delay_seconds: 6,
  business_context: "",
  personality:
    "Warm, concise, helpful Sri Lankan ecommerce salesperson. Never pressure the customer.",
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  updated_at: new Date(0).toISOString(),
};

export interface PurgedCustomerData {
  profiles: number;
  events: number;
  attentionItems: number;
  agentRuns: number;
  leadMemories: number;
}

async function ensureCrmSchema(): Promise<void> {
  if (!usingSupabase) return;
  const tenantId = (await requireTenantSession()).tenantId;
  const ready = (g.__crmSchemaReady ??= new Set());
  if (ready.has(tenantId)) return;
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
  const leadMemories = Number(memLeadMemories.delete(phoneKey));
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
  let agentRuns = 0;
  for (const [triggerId, run] of memRuns) {
    if (run.phone_key !== phoneKey && run.chat_id !== chatId) continue;
    memRuns.delete(triggerId);
    agentRuns += 1;
  }
  return { profiles, events, attentionItems, agentRuns, leadMemories };
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

export async function getAgentConfig(): Promise<AgentConfig> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase("select * from ai_agent_config where id=1");
    return rows[0]
      ? ({ ...DEFAULT_AGENT_CONFIG, ...rows[0] } as unknown as AgentConfig)
      : DEFAULT_AGENT_CONFIG;
  }
  return g.__agentConfig ?? DEFAULT_AGENT_CONFIG;
}

export async function updateAgentConfig(input: Partial<AgentConfig>): Promise<AgentConfig> {
  const current = await getAgentConfig();
  const next = { ...current, ...input, updated_at: nowIso() };
  if (usingSupabase) {
    const { rows } = await queryDatabase(
      `insert into ai_agent_config
         (id, mode, min_confidence, reply_delay_seconds, business_context,
          personality, quiet_hours_start, quiet_hours_end, updated_at)
       values (1,$1,$2,$3,$4,$5,$6,$7,now())
       on conflict (id) do update set
         mode=excluded.mode, min_confidence=excluded.min_confidence,
         reply_delay_seconds=excluded.reply_delay_seconds,
         business_context=excluded.business_context, personality=excluded.personality,
         quiet_hours_start=excluded.quiet_hours_start,
         quiet_hours_end=excluded.quiet_hours_end, updated_at=now()
       returning *`,
      [
        next.mode,
        next.min_confidence,
        next.reply_delay_seconds,
        next.business_context,
        next.personality,
        next.quiet_hours_start,
        next.quiet_hours_end,
      ]
    );
    return rows[0] as unknown as AgentConfig;
  }
  g.__agentConfig = next;
  return next;
}

export async function claimAgentRun(input: {
  trigger_message_id: string;
  phone_key: string;
  chat_id: string;
}): Promise<AgentRun | null> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `insert into ai_agent_runs (trigger_message_id, phone_key, chat_id)
       values ($1,$2,$3)
       on conflict (trigger_message_id) do update set
         intent=null, language=null, confidence=0, decision=null, reply='',
         status='processing', error='', feedback_status='none',
         feedback_reason='', final_reply='', reviewed_at=null,
         created_at=now(), completed_at=null
       where ai_agent_runs.status='failed'
       returning *`,
      [input.trigger_message_id, input.phone_key, input.chat_id]
    );
    return (rows[0] as unknown as AgentRun | undefined) ?? null;
  }
  const existing = memRuns.get(input.trigger_message_id);
  if (existing && existing.status !== "failed") return null;
  const run: AgentRun = {
    id: existing?.id ?? randomUUID(),
    trigger_message_id: input.trigger_message_id,
    phone_key: input.phone_key,
    chat_id: input.chat_id,
    intent: null,
    language: null,
    confidence: 0,
    decision: null,
    reply: "",
    status: "processing",
    error: "",
    feedback_status: "none",
    feedback_reason: "",
    final_reply: "",
    reviewed_at: null,
    created_at: nowIso(),
    completed_at: null,
  };
  memRuns.set(input.trigger_message_id, run);
  return run;
}

export async function finishAgentRun(
  triggerMessageId: string,
  input: {
    status: AgentRunStatus;
    decision?: AgentDecision | null;
    reply?: string;
    error?: string;
  }
): Promise<AgentRun | null> {
  const decision = input.decision ?? null;
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `update ai_agent_runs set
         intent=$2, language=$3, confidence=$4, decision=$5, reply=$6,
         status=$7::varchar, error=$8,
         feedback_status=case when $7::varchar='drafted' then 'pending' else feedback_status end,
         completed_at=now()
       where trigger_message_id=$1 returning *`,
      [
        triggerMessageId,
        decision?.intent ?? null,
        decision?.language ?? null,
        decision?.confidence ?? 0,
        decision ? JSON.stringify(decision) : null,
        input.reply ?? decision?.reply ?? "",
        input.status,
        input.error ?? "",
      ]
    );
    return (rows[0] as unknown as AgentRun | undefined) ?? null;
  }
  const current = memRuns.get(triggerMessageId);
  if (!current) return null;
  const next: AgentRun = {
    ...current,
    intent: decision?.intent ?? null,
    language: decision?.language ?? null,
    confidence: decision?.confidence ?? 0,
    decision,
    reply: input.reply ?? decision?.reply ?? "",
    status: input.status,
    error: input.error ?? "",
    feedback_status: input.status === "drafted" ? "pending" : current.feedback_status,
    completed_at: nowIso(),
  };
  memRuns.set(triggerMessageId, next);
  return next;
}

export async function expireStaleAgentRuns(maxAgeSeconds = 90): Promise<number> {
  const safeAge = Math.max(30, Math.min(600, Math.round(maxAgeSeconds)));
  const timeoutError =
    "The server stopped this run before recording a result. Check the latest conversation before retrying.";
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `update ai_agent_runs set
         status='failed', error=$2, completed_at=now()
       where status='processing'
         and created_at < now() - ($1::double precision * interval '1 second')
       returning id`,
      [safeAge, timeoutError]
    );
    return rows.length;
  }
  const cutoff = Date.now() - safeAge * 1000;
  let expired = 0;
  for (const [triggerId, run] of memRuns) {
    if (run.status !== "processing" || new Date(run.created_at).getTime() >= cutoff) continue;
    memRuns.set(triggerId, {
      ...run,
      status: "failed",
      error: timeoutError,
      completed_at: nowIso(),
    });
    expired += 1;
  }
  return expired;
}

export async function listAgentRuns(phoneKey?: string, limit = 100): Promise<AgentRun[]> {
  await expireStaleAgentRuns();
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `select * from ai_agent_runs
       where ($1::varchar is null or phone_key=$1)
       order by created_at desc limit $2`,
      [phoneKey ?? null, limit]
    );
    return rows as unknown as AgentRun[];
  }
  return [...memRuns.values()]
    .filter((run) => !phoneKey || run.phone_key === phoneKey)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

export async function getAgentRun(id: string): Promise<AgentRun | null> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase("select * from ai_agent_runs where id=$1", [id]);
    return (rows[0] as unknown as AgentRun | undefined) ?? null;
  }
  return [...memRuns.values()].find((run) => run.id === id) ?? null;
}

export async function claimAgentDraftReview(id: string): Promise<AgentRun | null> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `update ai_agent_runs as target set feedback_status='processing'
       where target.id=$1 and target.status='drafted' and target.feedback_status='pending'
         and not exists (
           select 1 from ai_agent_runs newer
           where newer.phone_key=target.phone_key and newer.created_at > target.created_at
         )
       returning *`,
      [id]
    );
    return (rows[0] as unknown as AgentRun | undefined) ?? null;
  }
  const run = await getAgentRun(id);
  if (!run || run.status !== "drafted" || run.feedback_status !== "pending") return null;
  const hasNewer = [...memRuns.values()].some(
    (candidate) =>
      candidate.phone_key === run.phone_key && candidate.created_at > run.created_at
  );
  if (hasNewer) return null;
  const next = { ...run, feedback_status: "processing" as const };
  memRuns.set(run.trigger_message_id, next);
  return next;
}

export async function finishAgentDraftReview(
  id: string,
  input: {
    status: "approved" | "edited" | "rejected" | "pending";
    reason?: string;
    finalReply?: string;
    sent?: boolean;
  }
): Promise<AgentRun | null> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      `update ai_agent_runs set
         feedback_status=$2, feedback_reason=$3, final_reply=$4,
         status=case when $5 then 'sent' else status end,
         reviewed_at=case when $2='pending' then null else now() end
       where id=$1 returning *`,
      [id, input.status, input.reason ?? "", input.finalReply ?? "", input.sent ?? false]
    );
    return (rows[0] as unknown as AgentRun | undefined) ?? null;
  }
  const run = await getAgentRun(id);
  if (!run) return null;
  const next: AgentRun = {
    ...run,
    feedback_status: input.status,
    feedback_reason: input.reason ?? "",
    final_reply: input.finalReply ?? "",
    status: input.sent ? "sent" : run.status,
    reviewed_at: input.status === "pending" ? null : nowIso(),
  };
  memRuns.set(run.trigger_message_id, next);
  return next;
}

export async function getLeadMemory(phoneKey: string): Promise<LeadMemory | null> {
  if (usingSupabase) {
    await ensureCrmSchema();
    const { rows } = await queryDatabase(
      "select * from ai_lead_memory where phone_key=$1",
      [phoneKey]
    );
    return (rows[0] as unknown as LeadMemory | undefined) ?? null;
  }
  return memLeadMemories.get(phoneKey) ?? null;
}

export async function updateLeadMemoryFromDecision(
  phoneKey: string,
  decision: AgentDecision
): Promise<LeadMemory> {
  const current = await getLeadMemory(phoneKey);
  const sameLanguage =
    current?.detected_language === decision.language &&
    current?.language_style === decision.language_style;
  const observations =
    decision.language_confidence >= 0.88
      ? sameLanguage
        ? (current?.language_observations ?? 0) + 1
        : 1
      : (current?.language_observations ?? 0);
  const collectedFields = [
    ...(current?.collected_fields ?? []),
    ...[
      decision.customer_name ? "name" : "",
      decision.interested_product ? "product" : "",
      decision.quantity ? "quantity" : "",
    ].filter(Boolean),
  ];
  const next: LeadMemory = {
    phone_key: phoneKey,
    detected_language:
      decision.language_confidence >= 0.75
        ? decision.language
        : (current?.detected_language ?? null),
    language_style:
      decision.language_confidence >= 0.75
        ? decision.language_style
        : (current?.language_style ?? null),
    language_confidence: Math.max(
      decision.language_confidence,
      sameLanguage ? (current?.language_confidence ?? 0) : 0
    ),
    language_observations: observations,
    interested_product: decision.interested_product || current?.interested_product || "",
    quantity: decision.quantity ?? current?.quantity ?? null,
    customer_need: decision.customer_need || current?.customer_need || "",
    objection: decision.objection,
    buying_intent: decision.buying_intent,
    collected_fields: [...new Set(collectedFields)],
    last_question: decision.next_action,
    next_action: decision.next_action,
    updated_at: nowIso(),
  };

  if (usingSupabase) {
    const { rows } = await queryDatabase(
      `insert into ai_lead_memory
         (phone_key, detected_language, language_style, language_confidence,
          language_observations, interested_product, quantity, customer_need,
          objection, buying_intent, collected_fields, last_question, next_action, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())
       on conflict (phone_key) do update set
         detected_language=excluded.detected_language,
         language_style=excluded.language_style,
         language_confidence=excluded.language_confidence,
         language_observations=excluded.language_observations,
         interested_product=excluded.interested_product,
         quantity=excluded.quantity,
         customer_need=excluded.customer_need,
         objection=excluded.objection,
         buying_intent=excluded.buying_intent,
         collected_fields=excluded.collected_fields,
         last_question=excluded.last_question,
         next_action=excluded.next_action,
         updated_at=now()
       returning *`,
      [
        phoneKey,
        next.detected_language,
        next.language_style,
        next.language_confidence,
        next.language_observations,
        next.interested_product,
        next.quantity,
        next.customer_need,
        next.objection,
        next.buying_intent,
        JSON.stringify(next.collected_fields),
        next.last_question,
        next.next_action,
      ]
    );
    return rows[0] as unknown as LeadMemory;
  }
  memLeadMemories.set(phoneKey, next);
  return next;
}

export function sanitizeLanguage(value: unknown): CustomerLanguage {
  return value === "si" || value === "ta" || value === "en" ? value : "auto";
}
