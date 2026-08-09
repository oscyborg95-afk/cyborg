// Multi-tenant supervisor and router. One deployed service owns multiple
// isolated Baileys child processes; adding a tenant is a database insert, not a
// deployment. Child crashes/reconnects cannot take down another tenant.
const http = require("http");
const { fork } = require("child_process");
const path = require("path");
const httpProxy = require("http-proxy");
const { Pool } = require("pg");
const { bearerToken, tenantFromWorkerAccessToken } = require("./access");

try {
  require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
} catch {}

const PORT = Number(process.env.WA_WORKER_PORT || process.env.PORT || 3001);
const DATABASE_URL = process.env.DATABASE_URL;
const SECRET = process.env.WORKER_API_SECRET || "";
const MAX_TENANTS = Math.max(1, Number(process.env.WA_MAX_TENANTS || 10));
const POLL_MS = Math.max(2_000, Number(process.env.WA_TENANT_POLL_MS || 10_000));
const FIRST_CHILD_PORT = Number(process.env.WA_CHILD_PORT_START || PORT + 100);

if (!DATABASE_URL) {
  console.error("[wa-manager] DATABASE_URL is required in multi-tenant mode");
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && !SECRET) {
  console.error("[wa-manager] WORKER_API_SECRET is required in production");
  process.exit(1);
}

const registry = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 10_000,
});
const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true });
const children = new Map();
let nextPort = FIRST_CHILD_PORT;

function startTrackingScheduler() {
  const url = process.env.APP_TRACKING_CRON_URL;
  const secret = process.env.CRON_SECRET;
  if (!url || !secret) return;
  const run = async () => {
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(55_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.error("[wa-manager] tracking fallback failed:", error.message);
    }
  };
  setTimeout(run, 5_000).unref();
  setInterval(run, 10 * 60 * 1000).unref();
}

function safeSchema(value) {
  return /^(public|tenant_[a-f0-9]{32})$/.test(value) ? value : null;
}

function startTenant(tenant) {
  if (children.has(tenant.id) || children.size >= MAX_TENANTS) return;
  const schema = safeSchema(tenant.schema_name);
  if (!schema) return console.error(`[wa-manager] refusing invalid schema for ${tenant.id}`);
  const port = nextPort++;
  const child = fork(path.join(__dirname, "index.js"), [], {
    env: {
      ...process.env,
      WA_WORKER_PORT: String(port),
      TENANT_ID: tenant.id,
      TENANT_NAME: tenant.name,
      WORKER_MANAGED: "true",
      PGOPTIONS: `-c search_path=${schema},public`,
      MIGRATE_FILE_AUTH: schema === "public" ? "true" : "false",
      // Only the manager runs global tracking cron. Tenant-specific WhatsApp
      // agent callbacks still originate from each child.
      APP_TRACKING_CRON_URL: "",
    },
    stdio: "inherit",
  });
  const state = { ...tenant, port, child, stopping: false };
  children.set(tenant.id, state);
  child.on("exit", (code, signal) => {
    if (children.get(tenant.id)?.child !== child) return;
    children.delete(tenant.id);
    console.error(`[wa-manager] tenant ${tenant.id} exited (${code ?? signal ?? "unknown"})`);
    if (!state.stopping) setTimeout(reconcile, 2_500);
  });
  console.log(`[wa-manager] tenant ${tenant.id} (${tenant.name}) started on :${port}`);
}

async function reconcile() {
  try {
    const { rows } = await registry.query(
      "select id::text, name, schema_name from public.app_tenants where status='active' order by created_at limit $1",
      [MAX_TENANTS]
    );
    const wanted = new Map(rows.map((tenant) => [tenant.id, tenant]));
    for (const tenant of rows) startTenant(tenant);
    for (const [tenantId, state] of children) {
      if (wanted.has(tenantId)) continue;
      state.stopping = true;
      state.child.kill("SIGTERM");
      children.delete(tenantId);
    }
  } catch (error) {
    // During the first app rollout the registry migration may not exist yet.
    console.error("[wa-manager] tenant registry unavailable:", error.message);
  }
}

function tenantForHttp(req) {
  const token = bearerToken(req.headers.authorization);
  if (SECRET && token === SECRET) return String(req.headers["x-tenant-id"] || "");
  return tenantFromWorkerAccessToken(token, SECRET) || "";
}

function targetFor(tenantId) {
  const state = children.get(tenantId);
  return state ? `http://127.0.0.1:${state.port}` : null;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, tenants: children.size, capacity: MAX_TENANTS }));
  }
  const tenantId = tenantForHttp(req);
  const target = targetFor(tenantId);
  if (!target) {
    res.writeHead(tenantId ? 503 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: tenantId ? "Tenant worker is starting" : "Unauthorized" }));
  }
  proxy.web(req, res, { target }, () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Tenant worker unavailable" }));
  });
});

server.on("upgrade", (req, socket, head) => {
  const match = String(req.url || "").match(/^\/t\/([0-9a-f-]{36})(\/socket\.io\/.*)$/i);
  const target = match && targetFor(match[1]);
  if (!match || !target) return socket.destroy();
  req.url = match[2];
  proxy.ws(req, socket, head, { target });
});

proxy.on("error", (error) => console.error("[wa-manager] proxy error:", error.message));

function shutdown() {
  for (const state of children.values()) {
    state.stopping = true;
    state.child.kill("SIGTERM");
  }
  registry.end().finally(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[wa-manager] listening on :${PORT}`);
  reconcile();
  setInterval(reconcile, POLL_MS).unref();
  startTrackingScheduler();
});
