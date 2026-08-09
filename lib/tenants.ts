import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { Pool, type PoolClient } from "pg";

const scrypt = promisify(scryptCallback);
const DATABASE_URL = process.env.DATABASE_URL;

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  schema_name: string;
  status: "active" | "suspended";
}

export interface AuthenticatedMembership {
  userId: string;
  tenant: TenantRecord;
  role: "owner" | "admin" | "member";
}

const globalRegistry = globalThis as unknown as {
  __tenantAdminPool?: Pool;
  __tenantRegistryReady?: Promise<void>;
  __tenantAuthorizationCache?: Map<string, { schema: string; expiresAt: number }>;
};
const adminPool = DATABASE_URL
  ? (globalRegistry.__tenantAdminPool ??= new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
    }))
  : null;

function safeSlug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

function schemaName(id: string): string {
  return `tenant_${id.replaceAll("-", "")}`;
}

async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString("base64url")}:${derived.toString("base64url")}`;
}

async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const [kind, saltText, hashText] = encoded.split(":");
  if (kind !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = (await scrypt(password, Buffer.from(saltText, "base64url"), expected.length)) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function ensureTenantRegistry(): Promise<void> {
  if (!adminPool) throw new Error("DATABASE_URL is required for multi-tenancy");
  globalRegistry.__tenantRegistryReady ??= adminPool.query(`
    create table if not exists public.app_tenants (
      id uuid primary key,
      slug varchar(48) not null unique,
      name varchar(120) not null,
      schema_name varchar(80) not null unique,
      status varchar(16) not null default 'active',
      created_at timestamptz not null default now()
    );
    create table if not exists public.app_users (
      id uuid primary key,
      email varchar(320) not null unique,
      password_hash text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists public.app_tenant_memberships (
      tenant_id uuid not null references public.app_tenants(id) on delete cascade,
      user_id uuid not null references public.app_users(id) on delete cascade,
      role varchar(16) not null default 'member',
      primary key (tenant_id, user_id)
    );
  `).then(async () => {
    const legacyPassword = process.env.APP_PASSWORD;
    if (!legacyPassword) return;
    const found = await adminPool.query("select id from public.app_tenants limit 1");
    if (found.rowCount) return;
    const tenantId = randomUUID();
    const userId = randomUUID();
    const email = (process.env.ADMIN_EMAIL || "owner@daily-cart.local").toLowerCase();
    await adminPool.query(
      `insert into public.app_tenants (id, slug, name, schema_name) values ($1,$2,$3,'public');
       insert into public.app_users (id, email, password_hash) values ($4,$5,$6);
       insert into public.app_tenant_memberships (tenant_id,user_id,role) values ($1,$4,'owner')`,
      [tenantId, process.env.DEFAULT_TENANT_SLUG || "daily-cart", process.env.DEFAULT_TENANT_NAME || "Daily Cart", userId, email, await passwordHash(legacyPassword)]
    );
  }).then(() => undefined);
  await globalRegistry.__tenantRegistryReady;
}

async function clonePublicSchema(client: PoolClient, targetSchema: string): Promise<void> {
  await client.query(`create schema ${targetSchema}`);
  const { rows: sequences } = await client.query<{ sequence_name: string }>(
    "select sequence_name from information_schema.sequences where sequence_schema='public' and sequence_name not like 'app_%'"
  );
  for (const { sequence_name } of sequences) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sequence_name)) continue;
    await client.query(`create sequence ${targetSchema}."${sequence_name}"`);
  }
  await client.query(`alter sequence ${targetSchema}.order_number_seq restart with 1001`).catch(() => {});
  const { rows: tables } = await client.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname='public'
     and tablename not in ('app_tenants','app_users','app_tenant_memberships','spatial_ref_sys')`
  );
  for (const { tablename } of tables) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tablename)) continue;
    await client.query(`create table ${targetSchema}."${tablename}" (like public."${tablename}" including all)`);
  }
  await client.query(`set local search_path to ${targetSchema}, public`);
  await client.query("insert into business_settings (id) values (1) on conflict do nothing").catch(() => {});
  await client.query("insert into ai_agent_config (id) values (1) on conflict do nothing").catch(() => {});
  await client.query("insert into ai_sales_style_profile (id) values (1) on conflict do nothing").catch(() => {});
}

export async function createTenantAccount(input: { email: string; password: string; businessName: string }): Promise<AuthenticatedMembership> {
  await ensureTenantRegistry();
  if (!adminPool) throw new Error("DATABASE_URL is required");
  const email = input.email.trim().toLowerCase();
  const baseSlug = safeSlug(input.businessName) || "workspace";
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Enter a valid email address");
  if (input.password.length < 10) throw new Error("Password must be at least 10 characters");
  if (!input.businessName.trim()) throw new Error("Business name is required");
  const tenantId = randomUUID();
  const userId = randomUUID();
  const schema = schemaName(tenantId);
  const client = await adminPool.connect();
  try {
    await client.query("begin");
    const collision = await client.query("select 1 from public.app_users where email=$1", [email]);
    if (collision.rowCount) throw new Error("An account with this email already exists");
    let slug = baseSlug;
    for (let suffix = 2; ; suffix += 1) {
      const found = await client.query("select 1 from public.app_tenants where slug=$1", [slug]);
      if (!found.rowCount) break;
      slug = `${baseSlug}-${suffix}`.slice(0, 48);
    }
    await clonePublicSchema(client, schema);
    await client.query(`update ${schema}.business_settings set business_name=$1 where id=1`, [input.businessName.trim()]).catch(() => {});
    await client.query("insert into public.app_tenants (id,slug,name,schema_name) values ($1,$2,$3,$4)", [tenantId, slug, input.businessName.trim(), schema]);
    await client.query("insert into public.app_users (id,email,password_hash) values ($1,$2,$3)", [userId, email, await passwordHash(input.password)]);
    await client.query("insert into public.app_tenant_memberships (tenant_id,user_id,role) values ($1,$2,'owner')", [tenantId, userId]);
    await client.query("commit");
    return { userId, tenant: { id: tenantId, slug, name: input.businessName.trim(), schema_name: schema, status: "active" }, role: "owner" };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateTenant(email: string, password: string): Promise<AuthenticatedMembership | null> {
  await ensureTenantRegistry();
  if (!adminPool) return null;
  const { rows } = await adminPool.query<AuthenticatedMembership["tenant"] & { user_id: string; password_hash: string; role: AuthenticatedMembership["role"] }>(
    `select t.*, u.id as user_id, u.password_hash, m.role
     from public.app_users u
     join public.app_tenant_memberships m on m.user_id=u.id
     join public.app_tenants t on t.id=m.tenant_id
     where u.email=$1 and t.status='active'
     order by t.created_at limit 1`,
    [email.trim().toLowerCase()]
  );
  const row = rows[0];
  if (!row || !(await passwordMatches(password, row.password_hash))) return null;
  return {
    userId: row.user_id,
    role: row.role,
    tenant: { id: row.id, slug: row.slug, name: row.name, schema_name: row.schema_name, status: row.status },
  };
}

export async function tenantSchemaForId(tenantId: string): Promise<string> {
  await ensureTenantRegistry();
  if (!adminPool) throw new Error("DATABASE_URL is required");
  const cache = (globalRegistry.__tenantAuthorizationCache ??= new Map());
  const cached = cache.get(`${tenantId}:system`);
  if (cached && cached.expiresAt > Date.now()) return cached.schema;
  const { rows } = await adminPool.query<{ schema_name: string }>("select schema_name from public.app_tenants where id=$1 and status='active'", [tenantId]);
  if (!rows[0]) throw new Error("Tenant is unavailable");
  cache.set(`${tenantId}:system`, { schema: rows[0].schema_name, expiresAt: Date.now() + 30_000 });
  return rows[0].schema_name;
}

export async function authorizedTenantSchema(tenantId: string, userId: string): Promise<string> {
  await ensureTenantRegistry();
  if (!adminPool) throw new Error("DATABASE_URL is required");
  // Non-UUID identities exist only inside withTenant() for authenticated
  // worker/webhook/cron execution. Browser sessions always carry a registry UUID.
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return tenantSchemaForId(tenantId);
  const cache = (globalRegistry.__tenantAuthorizationCache ??= new Map());
  const cacheKey = `${tenantId}:${userId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.schema;
  const { rows } = await adminPool.query<{ schema_name: string }>(
    `select t.schema_name from public.app_tenants t
     join public.app_tenant_memberships m on m.tenant_id=t.id
     where t.id=$1 and m.user_id=$2 and t.status='active'`,
    [tenantId, userId]
  );
  if (!rows[0]) throw new Error("Tenant membership is unavailable");
  cache.set(cacheKey, { schema: rows[0].schema_name, expiresAt: Date.now() + 30_000 });
  return rows[0].schema_name;
}

export async function listActiveTenants(): Promise<TenantRecord[]> {
  await ensureTenantRegistry();
  if (!adminPool) return [];
  const { rows } = await adminPool.query<TenantRecord>(
    "select id::text,slug,name,schema_name,status from public.app_tenants where status='active' order by created_at"
  );
  return rows;
}

export async function findTenantForWaybill(trackingId: string): Promise<TenantRecord | null> {
  if (!adminPool) return null;
  for (const tenant of await listActiveTenants()) {
    if (!/^(public|tenant_[a-f0-9]{32})$/.test(tenant.schema_name)) continue;
    const found = await adminPool.query(
      `select 1 from ${tenant.schema_name}.shipping_manifests where tracking_id=$1 limit 1`,
      [trackingId]
    ).catch(() => ({ rowCount: 0 }));
    if (found.rowCount) return tenant;
  }
  return null;
}
