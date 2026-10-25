import { createHash } from "crypto";

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

// The app self-migrates (create/alter ... if not exists) so a fresh database or
// a new tenant schema works without a manual schema run. Running that DDL on
// every serverless cold start made Supabase's PostgREST reload its whole schema
// cache each time (~175k reloads by Oct 2026), so each migration block now
// records a fingerprint of its own source per schema and only re-runs when that
// source changes (in practice: once per schema after a deploy that edits it).

let markTableExists = false;

function fingerprintOf(source: (...args: never[]) => unknown): string {
  return createHash("sha256").update(source.toString()).digest("hex").slice(0, 32);
}

export async function schemaIsCurrent(
  db: Queryable,
  name: string,
  source: (...args: never[]) => unknown
): Promise<boolean> {
  // Checked separately so a missing table never raises inside a caller's transaction.
  if (!markTableExists) {
    const { rows } = await db.query("select to_regclass('public.app_schema_marks') is not null as ok");
    if (!rows[0]?.ok) return false;
    markTableExists = true;
  }
  const { rows } = await db.query(
    "select 1 from public.app_schema_marks where schema_name = current_schema() and name = $1 and fingerprint = $2",
    [name, fingerprintOf(source)]
  );
  return rows.length > 0;
}

export async function markSchemaCurrent(
  db: Queryable,
  name: string,
  source: (...args: never[]) => unknown
): Promise<void> {
  if (!markTableExists) {
    await db.query(`create table if not exists public.app_schema_marks (
      schema_name varchar(80) not null,
      name varchar(80) not null,
      fingerprint varchar(64) not null,
      applied_at timestamptz not null default now(),
      primary key (schema_name, name)
    )`);
    markTableExists = true;
  }
  await db.query(
    `insert into public.app_schema_marks (schema_name, name, fingerprint)
     values (current_schema(), $1, $2)
     on conflict (schema_name, name) do update set fingerprint = excluded.fingerprint, applied_at = now()`,
    [name, fingerprintOf(source)]
  );
}
