// Storage for the automatic follow-up engine: operator settings (including the
// message text itself), one enrollment per cold lead, and a send log that both
// audits what went out and enforces the daily cap.
//
// Mirrors lib/crm-db.ts: Postgres when DATABASE_URL is set, in-memory maps
// otherwise, so the dashboard still works before the database is provisioned.

import { randomUUID } from "crypto";
import { queryDatabase, usingSupabase } from "./db";
import { requireTenantSession } from "./tenant-context.ts";
import type {
  ChatStateValue,
  FollowUpEnrollment,
  FollowUpSend,
  FollowUpSequence,
  FollowUpSettings,
} from "./types";

const g = globalThis as unknown as {
  __followUpSchemaReady?: Set<string>;
  __followUpSettings?: FollowUpSettings;
  __followUpEnrollments?: Map<string, FollowUpEnrollment>;
  __followUpSends?: FollowUpSend[];
};

const memEnrollments: Map<string, FollowUpEnrollment> = (g.__followUpEnrollments ??= new Map());
const memSends: FollowUpSend[] = (g.__followUpSends ??= []);

// Starting copy. Every line is editable from the Follow-ups page — these are
// only the defaults a fresh install begins with. Two variants per step is the
// minimum that keeps bulk sends from looking like bulk sends.
export const DEFAULT_SEQUENCES: FollowUpSequence[] = [
  {
    trigger_state: "AWAITING_ADDRESS",
    enabled: true,
    steps: [
      {
        delay_hours: 4,
        label: "Gentle nudge",
        variants: [
          `පොඩි reminder එකක් 🙏 ඔබගේ order එක process කරන්න මේ විස්තර තාම බලාපොරොත්තුවෙන් ඉන්නවා:\n\n1. නම\n2. Address එක (district එකත් එක්ක)\n3. Phone number\n\nවිස්තර එවපු ගමන් delivery යවන්නම්! 🚚`,
          `ආයුබෝවන් {{name}} 🙏\nඔබගේ order එකට address එක තාම ලැබුණේ නෑ. නම, address එක (district එකත් එක්ක), phone number එක එවන්න — අදම courier එකට දෙන්නම් 📦`,
        ],
      },
      {
        delay_hours: 20,
        label: "Make it easy",
        variants: [
          `Address එක type කරන එක අමාරුයි නම් voice message එකකින් කිව්වත් ඇති 🎤\nDelivery එක ගෙදරටම — ලැබෙනකොට ගෙවන්න (COD) ✅`,
          `තාම order එක වලංගුයි 😊 Address එක එවන්න විතරයි තියෙන්නේ.\nවෙන ප්‍රශ්නයක් තියෙනවා නම් මෙතනින්ම අහන්න — මම උදව් කරන්නම් 💚`,
        ],
      },
      {
        delay_hours: 48,
        label: "Last call",
        variants: [
          `මේක අන්තිම reminder එක 🙏 ඔබගේ order එක තව දවසක් reserve කරලා තියෙනවා.\nඕන නම් address එක එවන්න, නැත්නම් කමක් නෑ — කරදර කරන්නේ නෑ 😊`,
          `Order එක තාම ඕන නම් address එක එවන්න 📦\nදැන් එපා නම් reply කරන්න ඕන නෑ, මම මෙතනින් නවත්වන්නම් 🙏`,
        ],
      },
    ],
  },
  {
    trigger_state: "AWAITING_CONFIRMATION",
    enabled: true,
    steps: [
      {
        delay_hours: 3,
        label: "Confirm nudge",
        variants: [
          `ඔබගේ order එක confirm කරන්න තාම බලාපොරොත්තුවෙන් ඉන්නවා 😊\nOK කියලා reply කළොත් අදම process කරන්නම් ✅\nප්‍රශ්නයක් තියෙනවා නම් මෙතනින්ම අහන්න!`,
          `{{name}}, order එක confirm කරන්නද? 📦\nගෙදරටම delivery — ලැබෙනකොට ගෙවන්න (COD).\n*OK* කියලා reply කරන්න ✅`,
        ],
      },
      {
        delay_hours: 20,
        label: "Answer the doubt",
        variants: [
          `Order එක ගැන සැකයක් තියෙනවද? 🤔\nලැබෙනකොට තමයි ගෙවන්නේ — කලින් ගෙවන්න දෙයක් නෑ. Parcel එක බලලා ගන්න පුළුවන් 💚\nOK නම් reply කරන්න ✅`,
          `මොකක් හරි අහන්න තියෙනවා නම් අහන්න 😊 Price, delivery time, quality — මොකක් වුණත් කියන්නම්.\nOrder එක confirm කරන්න *OK* කියන්න ✅`,
        ],
      },
      {
        delay_hours: 48,
        label: "Last call",
        variants: [
          `මේක අන්තිම message එක 🙏 Order එක තව ටිකකට reserve කරලා තියෙනවා.\nඕන නම් *OK* කියන්න, නැත්නම් කමක් නෑ 😊`,
          `Order එක තාම ඕනද? *OK* කිව්වොත් අදම යවන්නම් 🚚\nදැන් එපා නම් කරදරයක් නෑ — ස්තූතියි! 💚`,
        ],
      },
    ],
  },
  {
    trigger_state: "NEW",
    enabled: false,
    steps: [
      {
        delay_hours: 6,
        label: "Reopen the chat",
        variants: [
          `ආයුබෝවන් 🙏 කලින් message එකට reply කරන්න බැරි වුණාද?\nProduct එක ගැන මොනවා හරි දැනගන්න ඕන නම් අහන්න — මම මෙතන ඉන්නවා 😊`,
          `Hi {{name}} 👋 ඔබ අහපු දේ ගැන තව විස්තර ඕන නම් කියන්න.\nStock තියෙනවා, ගෙදරටම delivery කරන්න පුළුවන් 📦`,
        ],
      },
      {
        delay_hours: 24,
        label: "Soft close",
        variants: [
          `තාම interested නම් කියන්න, මම details එවන්නම් 💚\nඑපා නම් කමක් නෑ — කරදර කරන්නේ නෑ 🙏`,
          `මොකක් හරි උදව්වක් ඕන නම් මේ chat එකට reply කරන්න 😊 ස්තූතියි!`,
        ],
      },
    ],
  },
];

export const DEFAULT_FOLLOW_UP_SETTINGS: FollowUpSettings = {
  // Off until the operator reads the copy and turns it on. An automation that
  // messages customers must never switch itself on during a deploy.
  enabled: false,
  daily_cap: 40,
  min_gap_minutes: 2,
  window_start: "09:00",
  window_end: "20:00",
  sequences: DEFAULT_SEQUENCES,
  updated_at: new Date(0).toISOString(),
};

async function ensureFollowUpSchema(): Promise<void> {
  if (!usingSupabase) return;
  const tenantId = (await requireTenantSession()).tenantId;
  const ready = (g.__followUpSchemaReady ??= new Set());
  if (ready.has(tenantId)) return;
  await queryDatabase(`
    create table if not exists follow_up_settings (
      id int primary key default 1,
      enabled boolean not null default false,
      daily_cap int not null default 40,
      min_gap_minutes int not null default 2,
      window_start varchar not null default '09:00',
      window_end varchar not null default '20:00',
      sequences jsonb not null default '[]'::jsonb,
      updated_at timestamptz not null default now()
    );
    insert into follow_up_settings (id) values (1) on conflict do nothing;
    create table if not exists follow_up_enrollments (
      id uuid primary key default gen_random_uuid(),
      phone_key varchar(9) not null,
      chat_id varchar not null,
      trigger_state varchar not null,
      step_index int not null default 0,
      status varchar not null default 'active',
      stop_reason text not null default '',
      baseline_inbound_at timestamptz,
      enrolled_at timestamptz not null default now(),
      last_sent_at timestamptz,
      next_run_at timestamptz not null default now(),
      attempts int not null default 0,
      last_error text not null default '',
      updated_at timestamptz not null default now()
    );
    -- One live sequence per customer, enforced by the database rather than by
    -- hope: two sweeps racing must not double-enroll the same person.
    create unique index if not exists uq_follow_up_active
      on follow_up_enrollments(phone_key) where status = 'active';
    create index if not exists idx_follow_up_due
      on follow_up_enrollments(status, next_run_at);
    create table if not exists follow_up_sends (
      id uuid primary key default gen_random_uuid(),
      enrollment_id uuid not null references follow_up_enrollments(id) on delete cascade,
      phone_key varchar(9) not null,
      chat_id varchar not null,
      step_index int not null,
      body text not null,
      sent_at timestamptz not null default now(),
      unique(enrollment_id, step_index)
    );
    create index if not exists idx_follow_up_sends_at on follow_up_sends(sent_at desc);
  `);
  ready.add(tenantId);
}

function nowIso(): string {
  return new Date().toISOString();
}

// A settings row that predates a sequence (or has had its jsonb emptied) still
// needs something to send, so stored sequences are layered over the defaults
// per trigger state instead of replacing the list wholesale.
function mergeSequences(stored: unknown): FollowUpSequence[] {
  const list = Array.isArray(stored) ? (stored as FollowUpSequence[]) : [];
  return DEFAULT_SEQUENCES.map((fallback) => {
    const match = list.find((s) => s?.trigger_state === fallback.trigger_state);
    if (!match || !Array.isArray(match.steps) || match.steps.length === 0) return fallback;
    return {
      trigger_state: fallback.trigger_state,
      enabled: Boolean(match.enabled),
      steps: match.steps.map((step, index) => ({
        delay_hours: Number(step?.delay_hours) > 0 ? Number(step.delay_hours) : 24,
        label: String(step?.label ?? `Step ${index + 1}`),
        variants: (Array.isArray(step?.variants) ? step.variants : [])
          .map((v) => String(v ?? "").trim())
          .filter(Boolean),
      })).filter((step) => step.variants.length > 0),
    };
  });
}

export async function getFollowUpSettings(): Promise<FollowUpSettings> {
  if (usingSupabase) {
    await ensureFollowUpSchema();
    const { rows } = await queryDatabase("select * from follow_up_settings where id=1");
    const row = rows[0];
    if (!row) return DEFAULT_FOLLOW_UP_SETTINGS;
    return {
      enabled: Boolean(row.enabled),
      daily_cap: Number(row.daily_cap),
      min_gap_minutes: Number(row.min_gap_minutes),
      window_start: String(row.window_start),
      window_end: String(row.window_end),
      sequences: mergeSequences(row.sequences),
      updated_at: String(row.updated_at),
    };
  }
  return g.__followUpSettings ?? DEFAULT_FOLLOW_UP_SETTINGS;
}

export async function updateFollowUpSettings(
  input: Partial<FollowUpSettings>
): Promise<FollowUpSettings> {
  const current = await getFollowUpSettings();
  const next: FollowUpSettings = {
    ...current,
    ...input,
    // Hard ceiling on the blast radius: whatever the UI posts, one WhatsApp
    // account is never allowed to fire more than 200 unsolicited messages a day.
    daily_cap: Math.max(1, Math.min(200, Math.round(Number(input.daily_cap ?? current.daily_cap)))),
    min_gap_minutes: Math.max(
      1,
      Math.min(120, Math.round(Number(input.min_gap_minutes ?? current.min_gap_minutes)))
    ),
    sequences: mergeSequences(input.sequences ?? current.sequences),
    updated_at: nowIso(),
  };
  if (usingSupabase) {
    await ensureFollowUpSchema();
    await queryDatabase(
      `insert into follow_up_settings
         (id, enabled, daily_cap, min_gap_minutes, window_start, window_end, sequences, updated_at)
       values (1,$1,$2,$3,$4,$5,$6::jsonb, now())
       on conflict (id) do update set
         enabled=excluded.enabled, daily_cap=excluded.daily_cap,
         min_gap_minutes=excluded.min_gap_minutes, window_start=excluded.window_start,
         window_end=excluded.window_end, sequences=excluded.sequences, updated_at=now()`,
      [
        next.enabled,
        next.daily_cap,
        next.min_gap_minutes,
        next.window_start,
        next.window_end,
        JSON.stringify(next.sequences),
      ]
    );
    return next;
  }
  g.__followUpSettings = next;
  return next;
}

export async function listEnrollments(
  status?: FollowUpEnrollment["status"],
  limit = 200
): Promise<FollowUpEnrollment[]> {
  if (usingSupabase) {
    await ensureFollowUpSchema();
    const { rows } = await queryDatabase(
      `select * from follow_up_enrollments
        where ($1::varchar is null or status=$1)
        order by case when status='active' then 0 else 1 end, next_run_at asc, updated_at desc
        limit $2`,
      [status ?? null, limit]
    );
    return rows as unknown as FollowUpEnrollment[];
  }
  return [...memEnrollments.values()]
    .filter((e) => !status || e.status === status)
    .sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))
    .slice(0, limit);
}

export async function getActiveEnrollmentKeys(): Promise<Set<string>> {
  const active = await listEnrollments("active", 1000);
  return new Set(active.map((e) => e.phone_key));
}

export async function enrollLead(input: {
  phone_key: string;
  chat_id: string;
  trigger_state: ChatStateValue;
  baseline_inbound_at: string | null;
  next_run_at: string;
}): Promise<FollowUpEnrollment | null> {
  if (usingSupabase) {
    await ensureFollowUpSchema();
    // do nothing (not do update): losing the race means someone else already
    // has this lead, which is exactly the desired outcome.
    const { rows } = await queryDatabase(
      `insert into follow_up_enrollments
         (phone_key, chat_id, trigger_state, baseline_inbound_at, next_run_at)
       values ($1,$2,$3,$4,$5)
       on conflict (phone_key) where status='active' do nothing
       returning *`,
      [
        input.phone_key,
        input.chat_id,
        input.trigger_state,
        input.baseline_inbound_at,
        input.next_run_at,
      ]
    );
    return (rows[0] as unknown as FollowUpEnrollment | undefined) ?? null;
  }
  const existing = [...memEnrollments.values()].find(
    (e) => e.phone_key === input.phone_key && e.status === "active"
  );
  if (existing) return null;
  const now = nowIso();
  const enrollment: FollowUpEnrollment = {
    id: randomUUID(),
    phone_key: input.phone_key,
    chat_id: input.chat_id,
    trigger_state: input.trigger_state,
    step_index: 0,
    status: "active",
    stop_reason: "",
    baseline_inbound_at: input.baseline_inbound_at,
    enrolled_at: now,
    last_sent_at: null,
    next_run_at: input.next_run_at,
    attempts: 0,
    last_error: "",
    updated_at: now,
  };
  memEnrollments.set(enrollment.id, enrollment);
  return enrollment;
}

// Claims due enrollments by pushing next_run_at forward (a lease). If this
// process dies mid-send the lead is retried after the lease expires rather than
// being chased by two tickers at once.
export async function claimDueEnrollments(
  limit = 1,
  leaseMinutes = 5
): Promise<FollowUpEnrollment[]> {
  if (usingSupabase) {
    await ensureFollowUpSchema();
    const { rows } = await queryDatabase(
      `with due as (
         select id from follow_up_enrollments
          where status='active' and next_run_at <= now()
          order by next_run_at asc limit $1 for update skip locked
       )
       update follow_up_enrollments e
          set next_run_at = now() + make_interval(mins => $2::int), updated_at = now()
         from due where e.id = due.id returning e.*`,
      [limit, leaseMinutes]
    );
    return rows as unknown as FollowUpEnrollment[];
  }
  const now = Date.now();
  return [...memEnrollments.values()]
    .filter((e) => e.status === "active" && Date.parse(e.next_run_at) <= now)
    .sort((a, b) => a.next_run_at.localeCompare(b.next_run_at))
    .slice(0, limit)
    .map((e) => {
      const leased = {
        ...e,
        next_run_at: new Date(now + leaseMinutes * 60_000).toISOString(),
        updated_at: nowIso(),
      };
      memEnrollments.set(e.id, leased);
      return leased;
    });
}

export async function stopEnrollment(
  id: string,
  status: "done" | "stopped",
  reason: string
): Promise<void> {
  if (usingSupabase) {
    await ensureFollowUpSchema();
    await queryDatabase(
      "update follow_up_enrollments set status=$2, stop_reason=$3, updated_at=now() where id=$1",
      [id, status, reason.slice(0, 300)]
    );
    return;
  }
  const current = memEnrollments.get(id);
  if (current) {
    memEnrollments.set(id, {
      ...current,
      status,
      stop_reason: reason.slice(0, 300),
      updated_at: nowIso(),
    });
  }
}

// Stops whatever sequence is chasing this customer. Called when they reply, when
// their order is confirmed, and when they ask us to stop.
export async function stopActiveEnrollmentFor(phoneKey: string, reason: string): Promise<boolean> {
  if (usingSupabase) {
    await ensureFollowUpSchema();
    const { rowCount } = await queryDatabase(
      `update follow_up_enrollments set status='stopped', stop_reason=$2, updated_at=now()
        where phone_key=$1 and status='active'`,
      [phoneKey, reason.slice(0, 300)]
    );
    return (rowCount ?? 0) > 0;
  }
  let stopped = false;
  for (const [id, e] of memEnrollments) {
    if (e.phone_key !== phoneKey || e.status !== "active") continue;
    memEnrollments.set(id, {
      ...e,
      status: "stopped",
      stop_reason: reason.slice(0, 300),
      updated_at: nowIso(),
    });
    stopped = true;
  }
  return stopped;
}

export async function recordFollowUpSend(input: {
  enrollment_id: string;
  phone_key: string;
  chat_id: string;
  step_index: number;
  body: string;
  next_step_index: number | null;
  next_run_at: string | null;
}): Promise<void> {
  if (usingSupabase) {
    await ensureFollowUpSchema();
    await queryDatabase(
      `insert into follow_up_sends (enrollment_id, phone_key, chat_id, step_index, body)
       values ($1,$2,$3,$4,$5) on conflict (enrollment_id, step_index) do nothing`,
      [input.enrollment_id, input.phone_key, input.chat_id, input.step_index, input.body]
    );
    if (input.next_step_index === null || input.next_run_at === null) {
      await queryDatabase(
        `update follow_up_enrollments
            set status='done', stop_reason='Sequence finished', last_sent_at=now(),
                attempts=0, last_error='', updated_at=now()
          where id=$1`,
        [input.enrollment_id]
      );
      return;
    }
    await queryDatabase(
      `update follow_up_enrollments
          set step_index=$2, next_run_at=$3, last_sent_at=now(),
              attempts=0, last_error='', updated_at=now()
        where id=$1`,
      [input.enrollment_id, input.next_step_index, input.next_run_at]
    );
    return;
  }
  const now = nowIso();
  memSends.push({
    id: randomUUID(),
    enrollment_id: input.enrollment_id,
    phone_key: input.phone_key,
    chat_id: input.chat_id,
    step_index: input.step_index,
    body: input.body,
    sent_at: now,
  });
  const current = memEnrollments.get(input.enrollment_id);
  if (!current) return;
  memEnrollments.set(input.enrollment_id, {
    ...current,
    step_index: input.next_step_index ?? current.step_index,
    status: input.next_step_index === null ? "done" : "active",
    stop_reason: input.next_step_index === null ? "Sequence finished" : current.stop_reason,
    next_run_at: input.next_run_at ?? current.next_run_at,
    last_sent_at: now,
    attempts: 0,
    last_error: "",
    updated_at: now,
  });
}

export async function failEnrollmentAttempt(
  id: string,
  error: string,
  retryAt: string,
  maxAttempts = 3
): Promise<void> {
  if (usingSupabase) {
    await ensureFollowUpSchema();
    await queryDatabase(
      `update follow_up_enrollments set
         attempts = attempts + 1,
         last_error = $2,
         next_run_at = $3,
         status = case when attempts + 1 >= $4 then 'stopped' else status end,
         stop_reason = case when attempts + 1 >= $4 then 'Send failed repeatedly' else stop_reason end,
         updated_at = now()
       where id=$1`,
      [id, error.slice(0, 300), retryAt, maxAttempts]
    );
    return;
  }
  const current = memEnrollments.get(id);
  if (!current) return;
  const attempts = current.attempts + 1;
  memEnrollments.set(id, {
    ...current,
    attempts,
    last_error: error.slice(0, 300),
    next_run_at: retryAt,
    status: attempts >= maxAttempts ? "stopped" : current.status,
    stop_reason: attempts >= maxAttempts ? "Send failed repeatedly" : current.stop_reason,
    updated_at: nowIso(),
  });
}

// Rolling-24h send count and the last send time — the two numbers that enforce
// the daily cap and the minimum gap between messages.
export async function getSendPace(): Promise<{ sent_24h: number; last_sent_at: string | null }> {
  if (usingSupabase) {
    await ensureFollowUpSchema();
    const { rows } = await queryDatabase(
      `select count(*)::int as sent_24h,
              (select max(sent_at) from follow_up_sends) as last_sent_at
         from follow_up_sends where sent_at > now() - interval '24 hours'`
    );
    return {
      sent_24h: Number(rows[0]?.sent_24h ?? 0),
      last_sent_at: (rows[0]?.last_sent_at as string | null) ?? null,
    };
  }
  const cutoff = Date.now() - 24 * 3_600_000;
  const recent = memSends.filter((s) => Date.parse(s.sent_at) > cutoff);
  const last = memSends.reduce<string | null>(
    (acc, s) => (!acc || s.sent_at > acc ? s.sent_at : acc),
    null
  );
  return { sent_24h: recent.length, last_sent_at: last };
}

export async function listRecentSends(limit = 50): Promise<FollowUpSend[]> {
  if (usingSupabase) {
    await ensureFollowUpSchema();
    const { rows } = await queryDatabase(
      "select * from follow_up_sends order by sent_at desc limit $1",
      [limit]
    );
    return rows as unknown as FollowUpSend[];
  }
  return [...memSends].sort((a, b) => b.sent_at.localeCompare(a.sent_at)).slice(0, limit);
}
