// Cyborg OS — headless WhatsApp worker (Baileys — direct WebSocket, no Chrome).
//
// Real mode:  node index.js          (scan the QR once: /qr in a browser, or the
//                                     Workspace at :3000 shows it inline)
// Mock mode:  WA_MOCK=true node index.js   (seeded fake chats — no WhatsApp needed)
//
// Persistence: with DATABASE_URL set (read from ../.env.local or the platform
// env), the WhatsApp session + chat history live in Postgres, so redeploys and
// restarts never need a re-scan and the inbox survives. Without it, everything
// falls back to memory/disk (fine for local dev).
//
// Exposes REST + Socket.io on WA_WORKER_PORT (default 3001):
//   GET  /health                     → { ok, mode, ready }
//   GET  /qr                         → HTML page with the live QR to scan
//   GET  /qr.json                    → { ready, qr } (Workspace embeds this)
//   GET  /chats                      → [{ id, name, lastMessage, timestamp, unreadCount }]
//   GET  /messages/:chatId           → [{ id, chatId, body, fromMe, timestamp, senderName, status, media }]
//   GET  /media/:id                  → { mime, data } (base64) — captured photos/voice notes/stickers
//   DELETE /chats/:chatId            → purge this system's stored chat, messages, and media
//   GET  /avatar/:jid                → { url } — profile picture (null when none/hidden)
//   POST /send { chatId, text, media? { mime, data } } → { ok }
//   POST /read { chatId }            → { ok } — mark chat read on the phone (blue ticks)
//   POST /typing { chatId, state }   → { ok } — "composing" | "paused" presence
//   POST /logout                     → { ok } — unlink this device and generate a fresh QR
//   POST /mock/incoming { chatId, body, name?, altJid? }  (mock mode only; unknown chatId = new customer)
// Socket.io events: "wa:message", "wa:update" ({ id, chatId, status }),
//                   "wa:status" ({ ready }), "wa:qr" ({ qr })

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { bearerToken, verifyWorkerAccessToken } = require("./access");

// Pull DATABASE_URL (and friends) from the app's .env.local when running
// locally; deployed platforms inject real env vars instead.
(() => {
  const envFile = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2].replace(/^["']|["']$/g, "");
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
})();

// WA_WORKER_PORT wins (explicit override); else the platform's PORT (Railway,
// Render, Fly all inject this and route to it); else 3001 for local dev.
const PORT = Number(process.env.WA_WORKER_PORT || process.env.PORT || 3001);
const MOCK = process.env.WA_MOCK === "true";
const WORKER_API_SECRET = process.env.WORKER_API_SECRET || "";
const TENANT_ID = process.env.TENANT_ID || "";
const LISTEN_HOST = process.env.WORKER_MANAGED === "true" ? "127.0.0.1" : "0.0.0.0";
const APP_ORIGIN = (() => {
  try {
    return new URL(process.env.APP_URL || "http://localhost:3000").origin;
  } catch {
    return "http://localhost:3000";
  }
})();

const corsOptions = {
  origin(origin, callback) {
    callback(null, !origin || origin === APP_ORIGIN);
  },
};

const app = express();
app.use(cors(corsOptions));
// Base64 expands a 5 MB photo to about 6.7 MB. Keep the parser just above that
// while the /send route still enforces the decoded 6 MB media limit below.
app.use(express.json({ limit: "8mb" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: APP_ORIGIN } });

function requestIsAuthorized(req) {
  return verifyWorkerAccessToken(
    bearerToken(req.headers.authorization) || req.headers["x-worker-secret"],
    WORKER_API_SECRET,
    Date.now(),
    TENANT_ID
  );
}

// Health checks carry no business data. Every other REST and Socket.io entry
// point requires either the server secret or a short-lived dashboard token.
app.use((req, res, next) => {
  if (req.path === "/health" || requestIsAuthorized(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
});
io.use((socket, next) => {
  const token =
    socket.handshake.auth?.token || bearerToken(socket.handshake.headers.authorization);
  if (verifyWorkerAccessToken(token, WORKER_API_SECRET, Date.now(), TENANT_ID)) return next();
  next(new Error("Unauthorized"));
});

let ready = false;
let latestQr = null; // data:image/png;base64,... — the most recent QR to scan, if any

// --- Send idempotency ------------------------------------------------------
// The dashboard aborts a /send after WA_WORKER_TIMEOUT_MS (10s by default) and
// the notification queue retries it. If WhatsApp had in fact accepted the first
// attempt, the retry would deliver a second copy to the customer. Callers that
// can retry pass an idempotencyKey; we remember it just long enough to cover
// the retry window and answer repeats without touching WhatsApp again.
const SEND_IDEMPOTENCY_TTL_MS = 6 * 60 * 60 * 1000;
const sendLedger = new Map(); // key -> { at, promise }

function pruneSendLedger() {
  const cutoff = Date.now() - SEND_IDEMPOTENCY_TTL_MS;
  for (const [key, entry] of sendLedger) {
    if (entry.at < cutoff) sendLedger.delete(key);
  }
}

// Returns a response to replay, or null when this send should proceed.
function claimSendKey(key) {
  if (!key) return null;
  pruneSendLedger();
  const existing = sendLedger.get(key);
  if (existing) return existing;
  sendLedger.set(key, { at: Date.now(), done: false });
  return null;
}

function releaseSendKey(key, delivered) {
  if (!key) return;
  // A send that failed outright must be retryable, so drop the claim; a
  // delivered one stays in the ledger to absorb the duplicate retry.
  if (!delivered) sendLedger.delete(key);
  else sendLedger.set(key, { at: Date.now(), done: true });
}

// Welcome photos arrive as Oracle Object Storage links ({ url, key, mime }).
// Each is downloaded once and kept on this machine's disk, keyed by `key` (a
// new key per uploaded photo); every later send reads the local copy. Nothing
// is written to the database.
const MEDIA_REF_MAX_BYTES = 6 * 1024 * 1024;
const MEDIA_CACHE_DIR = process.env.WA_MEDIA_CACHE_DIR || path.join(__dirname, "media-cache");
const MEDIA_CACHE_MAX_FILES = 50;

function mediaHostAllowed(url) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    host = parsed.hostname;
  } catch {
    return false;
  }
  // Oracle Object Storage, where the app keeps welcome photos.
  if (/^objectstorage\.[a-z0-9-]+\.oraclecloud\.com$/.test(host)) return true;
  const extra = (process.env.WA_MEDIA_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean);
  return extra.includes(host);
}

async function loadMediaRef(ref) {
  if (!ref || typeof ref.url !== "string" || typeof ref.key !== "string" || !ref.key || ref.key.length > 300) {
    throw new Error("invalid mediaRef");
  }
  const mime = /^image\/(jpeg|png|webp)$/.test(ref.mime) ? ref.mime : "image/jpeg";
  const file = path.join(
    MEDIA_CACHE_DIR,
    `${require("crypto").createHash("sha256").update(ref.key).digest("hex")}.bin`
  );
  try {
    const cached = await fs.promises.readFile(file);
    const now = new Date();
    fs.promises.utimes(file, now, now).catch(() => {});
    return { buffer: cached, mime };
  } catch {
    // Not cached yet — download below.
  }
  if (!mediaHostAllowed(ref.url)) throw new Error("media host not allowed");
  const res = await fetch(ref.url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`media download failed (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MEDIA_REF_MAX_BYTES) throw new Error("media too large (6 MB max)");
  await fs.promises.mkdir(MEDIA_CACHE_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, buffer);
  await fs.promises.rename(tmp, file);
  pruneMediaCache().catch(() => {});
  return { buffer, mime };
}

// Replaced photos leave old copies behind; keep only the most recently used.
async function pruneMediaCache() {
  const names = (await fs.promises.readdir(MEDIA_CACHE_DIR)).filter((n) => n.endsWith(".bin"));
  if (names.length <= MEDIA_CACHE_MAX_FILES) return;
  const stats = await Promise.all(
    names.map(async (n) => ({ n, t: (await fs.promises.stat(path.join(MEDIA_CACHE_DIR, n))).mtimeMs }))
  );
  stats.sort((a, b) => a.t - b.t);
  for (const { n } of stats.slice(0, stats.length - MEDIA_CACHE_MAX_FILES)) {
    await fs.promises.unlink(path.join(MEDIA_CACHE_DIR, n)).catch(() => {});
  }
}

function startTrackingFallbackScheduler() {
  const url = process.env.APP_TRACKING_CRON_URL;
  const secret = process.env.CRON_SECRET;
  if (!url || !secret) {
    console.log("[cyborg-wa-worker] tracking fallback scheduler disabled (APP_TRACKING_CRON_URL / CRON_SECRET not set)");
    return;
  }
  const run = async (mode) => {
    const target = new URL(url);
    target.searchParams.set("mode", mode);
    try {
      const res = await fetch(target, { headers: { Authorization: `Bearer ${secret}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      console.log(`[cyborg-wa-worker] tracking ${mode} completed`);
    } catch (err) {
      console.error(`[cyborg-wa-worker] tracking ${mode} failed:`, err.message);
    }
  };
  // Draining the outbox costs one DB round trip, so it runs often enough that a
  // reminder scheduled for 07:00 actually goes out at 07:00. The full courier
  // reconciliation is the expensive one and stays on a slower beat.
  const drainMs = Math.max(60_000, Number(process.env.TRACKING_DRAIN_INTERVAL_MS || 120_000));
  const syncMs = Math.max(drainMs, Number(process.env.TRACKING_SYNC_INTERVAL_MS || 10 * 60_000));
  setTimeout(() => run("drain"), 30_000);
  setInterval(() => run("drain"), drainMs);
  setTimeout(() => run("sync"), 60_000);
  setInterval(() => run("sync"), syncMs);
}

// The follow-up engine's heartbeat. Each tick sends at most one message, so the
// interval *is* the pacing: cold leads are chased as a slow trickle across the
// day instead of a burst, which is what keeps this number off WhatsApp's radar.
// Randomised so sends do not land on a visibly mechanical 2-minute grid.
function startFollowUpScheduler() {
  const secret = process.env.CRON_SECRET;
  const base = process.env.APP_FOLLOWUP_CRON_URL || process.env.APP_URL;
  if (!base || !secret) {
    console.log(
      "[cyborg-wa-worker] follow-up scheduler disabled (APP_URL / CRON_SECRET not set)"
    );
    return;
  }
  const url = process.env.APP_FOLLOWUP_CRON_URL
    ? new URL(process.env.APP_FOLLOWUP_CRON_URL)
    : new URL("/api/followups/tick", base);
  const everyMs = Math.max(60_000, Number(process.env.FOLLOWUP_TICK_INTERVAL_MS || 150_000));

  const tick = async () => {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data = await res.json().catch(() => null);
      const sent = (data?.tenants ?? []).reduce((total, t) => total + (t.sent ?? 0), 0);
      if (sent > 0) console.log(`[cyborg-wa-worker] follow-ups sent: ${sent}`);
    } catch (err) {
      console.error("[cyborg-wa-worker] follow-up tick failed:", err.message);
    } finally {
      setTimeout(tick, everyMs + Math.round(Math.random() * 45_000));
    }
  };
  setTimeout(tick, 45_000);
}

function emitMessage(msg) {
  io.emit("wa:message", msg);
}

// What "read", "typing" and "send" mean differs between live WhatsApp and the
// mock; each mode fills these in. The welcome runner only uses these.
const waOps = { read: null, typing: null, send: null };

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Mirrors typingPauseMs in lib/welcome-policy.ts: longer text, longer typing.
const typingPause = (text) => 1_500 + Math.min(String(text || "").length, 300) * 12 + Math.random() * 1_500;

// Sends a welcome the app planned (see lib/welcome.ts), paced like a person:
// read first, a moment's pause, "typing…" before each message, and an album's
// photos one after another so WhatsApp groups them into a single grid. Runs
// here rather than in the app because a long welcome outlasts a Vercel
// function. A photo that fails is skipped; its caption moves to the next.
async function runWelcome(chatId, steps) {
  if (!Array.isArray(steps) || steps.length === 0 || !waOps.send) return 0;
  let sent = 0;
  try {
    await waOps.read(chatId).catch(() => {});
    await pause(1_000 + Math.random() * 2_000);
    for (const step of steps.slice(0, 4)) {
      const text = typeof step?.text === "string" ? step.text : "";
      const media = Array.isArray(step?.media) ? step.media.slice(0, 10) : [];
      await waOps.typing(chatId, "composing").catch(() => {});
      await pause(typingPause(text) + (media.length ? 1_500 : 0));
      let caption = text;
      for (const [i, ref] of media.entries()) {
        try {
          const photo = await loadMediaRef(ref);
          await waOps.send(chatId, { text: caption, image: photo.buffer, mime: photo.mime });
          caption = "";
          sent++;
        } catch (err) {
          console.error("[cyborg-wa-worker] welcome photo skipped:", err.message);
        }
        if (i < media.length - 1) await pause(700 + Math.random() * 900);
      }
      if (caption) {
        await waOps.send(chatId, { text: caption });
        sent++;
      }
    }
  } finally {
    await waOps.typing(chatId, "paused").catch(() => {});
  }
  return sent;
}

// WhatsApp increasingly identifies customers by a privacy ID (…@lid) instead
// of their number, but orders, parcel messages and customer records are filed
// under the number. Without it a returning customer looks brand new (Nov 28:
// two existing customers got the new-customer welcome). Null when unknown.
// "94771234567:12@s.whatsapp.net" (one device) → "94771234567@s.whatsapp.net".
const phoneJid = (jid) => (String(jid).endsWith("@s.whatsapp.net") ? String(jid).replace(/:\d+@/, "@") : null);

async function phoneJidFor(chatId, altJid) {
  if (!String(chatId).endsWith("@lid")) return null;
  if (altJid && phoneJid(altJid)) return phoneJid(altJid);
  try {
    return phoneJid(await sock.signalRepository.lidMapping.getPNForLID(chatId));
  } catch {
    return null;
  }
}

// Tell the app a customer wrote, once their burst of bubbles settles ("hi",
// "price?", a photo → one call). The app stops any follow-up chasing them and
// decides whether this is a brand-new customer who gets the automatic welcome.
// The wait is randomised (20–45s by default): an instant reply at 3 AM is
// what a bot looks like. Fire-and-forget: a failure here must never affect
// storing or showing the message.
const inboundTimers = new Map();
function notifyInbound(msg) {
  if (msg.fromMe) return;
  const base = process.env.APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!base || !secret || !TENANT_ID) return;
  const minDelay = Math.max(1_000, Number(process.env.INBOUND_DEBOUNCE_MS || 20_000));
  const jitter = Math.max(0, Number(process.env.INBOUND_JITTER_MS ?? 25_000));
  const pending = inboundTimers.get(msg.chatId);
  if (pending) clearTimeout(pending.timer);
  // Keep the burst's first timestamp: it is what "first contact" is measured from.
  const firstTs = pending ? Math.min(pending.firstTs, msg.timestamp) : msg.timestamp;
  const bodies = [...(pending?.bodies ?? []), msg.body].slice(-10);
  const altJid = msg.altJid || pending?.altJid || "";
  const timer = setTimeout(async () => {
    inboundTimers.delete(msg.chatId);
    try {
      const phoneChatId = await phoneJidFor(msg.chatId, altJid);
      const res = await fetch(new URL("/api/whatsapp/inbound", base), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
          "x-tenant-id": TENANT_ID,
        },
        body: JSON.stringify({ chatId: msg.chatId, phoneChatId, timestamp: firstTs, body: bodies.join("\n") }),
        signal: AbortSignal.timeout(55_000),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        console.error(`[cyborg-wa-worker] inbound hook failed (${res.status}): ${JSON.stringify(data).slice(0, 180)}`);
      } else if (data?.welcome?.send) {
        try {
          const sent = await runWelcome(msg.chatId, data.welcome.send);
          console.log(`[cyborg-wa-worker] welcome sent to new customer (${sent} messages)`);
        } catch (err) {
          console.error("[cyborg-wa-worker] welcome send failed:", err.message);
        }
      }
    } catch (err) {
      console.error("[cyborg-wa-worker] inbound hook offline:", err.message);
    }
  }, minDelay + Math.round(Math.random() * jitter));
  inboundTimers.set(msg.chatId, { timer, firstTs, bodies, altJid });
}

function setReady(value) {
  ready = value;
  io.emit("wa:status", { ready });
}

app.get("/health", (_req, res) => res.json({ ok: true, mode: MOCK ? "mock" : "live", ready, tenantId: TENANT_ID || null }));

// JSON twin of /qr — lets the Next.js Workspace embed the live QR inline.
app.get("/qr.json", (_req, res) => res.json({ ready, qr: latestQr }));

// A standalone page so linking WhatsApp doesn't depend on watching a terminal —
// open this URL from any browser (works the same on a deployed server as it
// does locally). Auto-refreshes so a freshly-rotated QR always shows.
app.get("/qr", (_req, res) => {
  res.set("Content-Type", "text/html");
  const shell = (body, refreshSeconds) => `<!doctype html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}" />` : ""}
<body style="font-family:system-ui,sans-serif;text-align:center;padding-top:3rem;background:#fbf7ef;color:#3f3a34">
  ${body}
</body>`;

  if (ready) {
    return res.send(
      shell(`<h1>✅ WhatsApp is connected</h1><p>This session is already linked — no QR needed.</p>`)
    );
  }
  if (!latestQr) {
    return res.send(
      shell(
        `<h1>⏳ Starting up…</h1><p>Generating a QR code — this page refreshes automatically.</p>`,
        3
      )
    );
  }
  res.send(
    shell(
      `<h1>📱 Scan to link WhatsApp</h1>
       <p>WhatsApp → Settings → Linked Devices → Link a Device</p>
       <img src="${latestQr}" width="300" height="300" style="border:8px solid #eee;border-radius:16px" />
       <p style="color:#8a8178">Refreshes automatically every 20s.</p>`,
      20
    )
  );
});

// ---------------------------------------------------------------------------
// MOCK MODE — an in-memory WhatsApp so the dashboard is fully testable
// ---------------------------------------------------------------------------
if (MOCK) {
  const now = Date.now();
  const chats = new Map(); // chatId -> { id, name, messages: [] }
  const mockMedia = new Map(); // msgId -> { mime, data }

  // The welcome runner's view of the mock: read ticks, no-op typing, and a
  // send that lands in the fake chat exactly like /send does.
  waOps.read = async (chatId) => {
    for (const m of chats.get(chatId)?.messages ?? []) if (!m.fromMe) m.status = 4;
  };
  waOps.typing = async () => {};
  waOps.send = async (chatId, { text, image, mime }) => {
    const chat = chats.get(chatId);
    if (!chat) throw new Error("unknown chat");
    const msg = {
      id: `${chat.id}-${chat.messages.length}`,
      chatId: chat.id,
      body: text || "[photo]",
      fromMe: true,
      timestamp: Date.now(),
      senderName: "You",
      status: 1,
      media: image ? "image" : "",
    };
    if (image) mockMedia.set(msg.id, { mime: mime || "image/jpeg", data: image.toString("base64") });
    chat.messages.push(msg);
    emitMessage(msg);
  };

  function seedChat(id, name, messages) {
    chats.set(id, {
      id,
      name,
      messages: messages.map((m, i) => ({
        id: `${id}-${i}`,
        chatId: id,
        body: m.body,
        fromMe: m.fromMe,
        timestamp: now - m.minAgo * 60_000,
        senderName: m.fromMe ? "You" : name,
        status: m.fromMe ? 4 : 0, // our seeded sends read as blue-ticked
        media: "",
      })),
    });
  }

  seedChat("94768846320@c.us", "Nimali", [
    { body: "Is this available?", fromMe: false, minAgo: 25 },
    { body: "Yes, available! Delivery in 2 days 🚚", fromMe: true, minAgo: 20 },
    {
      body: "Okay send me one. Here is my address... Nimali Perera, 45, Galle Road, Colombo 03. 0768846320",
      fromMe: false,
      minAgo: 11,
    },
  ]);
  seedChat("94712345678@c.us", "Priyan", [
    { body: "kohomada price eka?", fromMe: false, minAgo: 65 },
  ]);
  seedChat("94759876543@c.us", "Dilini", [
    { body: "Address: Dilini, 12 Kandy Rd, Kurunegala. 0759876543", fromMe: false, minAgo: 60 * 26 },
    { body: "ඔබගේ ඇණවුම සාර්ථකව තහවුරු කළා ✅", fromMe: true, minAgo: 60 * 24 },
  ]);

  app.get("/chats", (_req, res) => {
    const list = [...chats.values()].map((c) => {
      const last = c.messages[c.messages.length - 1];
      return {
        id: c.id,
        name: c.name,
        lastMessage: last?.body ?? "",
        timestamp: last?.timestamp ?? 0,
        unreadCount: last && !last.fromMe ? 1 : 0,
      };
    });
    list.sort((a, b) => b.timestamp - a.timestamp);
    res.json(list);
  });

  app.get("/messages/:chatId", (req, res) => {
    const chat = chats.get(req.params.chatId);
    res.json(chat ? chat.messages : []);
  });

  app.delete("/chats/:chatId", (req, res) => {
    const chatId = req.params.chatId;
    const chat = chats.get(chatId);
    let media = 0;
    for (const message of chat?.messages ?? []) {
      if (mockMedia.delete(message.id)) media += 1;
    }
    const deleted = chats.delete(chatId);
    io.emit("wa:chat-deleted", { chatId });
    res.json({
      ok: true,
      deleted: {
        chats: Number(deleted),
        messages: chat?.messages.length ?? 0,
        media,
      },
    });
  });

  app.post("/send", (req, res) => {
    const { chatId, text, media, expectedLatestMessageId, idempotencyKey } = req.body;
    if (claimSendKey(idempotencyKey)) {
      return res.json({ ok: true, deduped: true });
    }
    // Live WhatsApp JIDs end in @s.whatsapp.net; the mock seeds use @c.us.
    // Match by phone digits so server-side sends (alerts, broadcast) work here.
    let chat = chats.get(chatId);
    if (!chat && chatId) {
      const digits = String(chatId).split("@")[0];
      chat = [...chats.values()].find((c) => c.id.split("@")[0] === digits);
    }
    if (!chat || (!text && !media?.data)) {
      releaseSendKey(idempotencyKey, false);
      return res.status(400).json({ error: "unknown chatId or empty text" });
    }
    const latest = chat.messages[chat.messages.length - 1];
    if (
      expectedLatestMessageId &&
      (!latest || latest.fromMe || latest.id !== expectedLatestMessageId)
    ) {
      releaseSendKey(idempotencyKey, false);
      return res.status(409).json({ error: "A newer message superseded this AI reply" });
    }
    releaseSendKey(idempotencyKey, true);
    const msg = {
      id: `${chat.id}-${chat.messages.length}`,
      chatId: chat.id,
      body: text || "[photo]",
      fromMe: true,
      timestamp: Date.now(),
      senderName: "You",
      status: 1,
      media: media?.data ? "image" : "",
    };
    if (media?.data) mockMedia.set(msg.id, { mime: media.mime || "image/jpeg", data: media.data });
    chat.messages.push(msg);
    emitMessage(msg);
    res.json({ ok: true });
    // Walk the ticks like a real send: sent → delivered → read.
    for (const [status, delay] of [
      [2, 700],
      [3, 1800],
      [4, 4000],
    ]) {
      setTimeout(() => {
        msg.status = status;
        io.emit("wa:update", { id: msg.id, chatId: msg.chatId, status });
      }, delay);
    }
  });

  // Serves photos sent from the dashboard; seeded chats carry no media.
  app.get("/media/:id", (req, res) => {
    const m = mockMedia.get(req.params.id);
    if (!m) return res.status(404).json({ error: "no media captured for this message" });
    res.json(m);
  });

  app.post("/read", (req, res) => {
    const chat = chats.get(req.body.chatId);
    if (chat) chat.messages.forEach((m) => { if (!m.fromMe) m.status = 4; });
    res.json({ ok: true });
  });
  app.post("/typing", (_req, res) => res.json({ ok: true }));
  app.get("/avatar/:jid", (_req, res) => res.json({ url: null }));
  app.post("/logout", (_req, res) =>
    res.status(409).json({
      error: "Account switching is unavailable in mock mode because no real WhatsApp account is linked.",
    })
  );

  app.post("/mock/incoming", (req, res) => {
    const { chatId, body, name, altJid } = req.body;
    if (!chatId || !body) return res.status(400).json({ error: "chatId and body required" });
    // An unknown chatId is a brand-new customer writing for the first time.
    if (!chats.has(chatId)) chats.set(chatId, { id: chatId, name: name || chatId.split("@")[0], messages: [] });
    const chat = chats.get(chatId);
    const msg = {
      id: `${chatId}-${chat.messages.length}`,
      chatId,
      body,
      fromMe: false,
      timestamp: Date.now(),
      senderName: chat.name,
      status: 0,
      media: "",
      altJid: altJid || "",
    };
    chat.messages.push(msg);
    emitMessage(msg);
    notifyInbound(msg);
    res.json({ ok: true });
  });

  server.listen(PORT, LISTEN_HOST, () => {
    setReady(true);
    console.log(`[cyborg-wa-worker] MOCK mode on :${PORT}`);
    startTrackingFallbackScheduler();
    startFollowUpScheduler();
  });
  return;
}

// ---------------------------------------------------------------------------
// LIVE MODE — Baileys (https://baileys.wiki), direct WebSocket to WhatsApp.
// No browser involved: light enough for a $2 container host.
// ---------------------------------------------------------------------------
const {
  makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  isJidGroup,
  isJidBroadcast,
  isJidNewsletter,
  isJidStatusBroadcast,
  proto,
} = require("baileys");
const pino = require("pino");
const QRCode = require("qrcode");

const logger = pino({ level: "warn" });

// --- Store: Postgres when DATABASE_URL is set, otherwise in-memory ----------

const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;
if (DATABASE_URL) {
  const { Pool, types } = require("pg");
  types.setTypeParser(20, Number); // bigint → number (our timestamps fit safely)
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 15_000,
  });
}

const memChats = new Map(); // jid -> { name, unread, lastTs, lastMessage }
const memMessages = new Map(); // jid -> Map(id -> msg)
const memMedia = new Map(); // msgId -> { mime, data (base64) }

async function ensureTables() {
  if (!pool) return;
  await pool.query(`
    create table if not exists wa_auth (
      id   text primary key,
      data text not null
    );
    create table if not exists wa_chats (
      jid          text primary key,
      name         text not null default '',
      unread       int not null default 0,
      last_ts      bigint not null default 0,
      last_message text not null default ''
    );
    create table if not exists wa_messages (
      id      text primary key,
      jid     text not null,
      body    text not null,
      from_me boolean not null,
      ts      bigint not null,
      sender  text not null default ''
    );
    alter table wa_messages add column if not exists status int not null default 0;
    alter table wa_messages add column if not exists media text not null default '';
    create index if not exists idx_wa_messages_jid_ts on wa_messages(jid, ts);
    create index if not exists idx_wa_chats_last_ts on wa_chats(last_ts desc);
    create table if not exists wa_media (
      id   text primary key,
      mime text not null,
      data text not null,
      ts   bigint not null
    );
  `);
  // Media bytes are no longer stored (they filled the free-tier DB and made it
  // read-only). Clear any leftovers; the UI shows a "[photo]" placeholder.
  await pool.query("delete from wa_media").catch(() => {});
}

// --- Media (read-only: nothing writes wa_media any more) ---------------------

async function getMedia(id) {
  if (pool) {
    const { rows } = await pool.query("select mime, data from wa_media where id = $1", [id]);
    return rows[0] ?? null;
  }
  return memMedia.get(id) ?? null;
}

/** Store one normalized message. Returns false if we'd already seen it. */
async function saveMessage(msg) {
  if (pool) {
    const inserted = await pool.query(
      `insert into wa_messages (id, jid, body, from_me, ts, sender, status, media)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing returning id`,
      [
        msg.id,
        msg.chatId,
        msg.body,
        msg.fromMe,
        msg.timestamp,
        msg.senderName,
        msg.status ?? 0,
        msg.media ?? "",
      ]
    );
    if (inserted.rowCount === 0) return false;
    await pool.query(
      `insert into wa_chats (jid, name, unread, last_ts, last_message)
       values ($1, $2, $3, $4, $5)
       on conflict (jid) do update set
         name = case when $2 <> '' then $2 else wa_chats.name end,
         unread = case when $3 = 0 then 0 else wa_chats.unread + $3 end,
         last_ts = greatest(wa_chats.last_ts, $4),
         last_message = case when $4 >= wa_chats.last_ts then $5 else wa_chats.last_message end`,
      [msg.chatId, msg.fromMe ? "" : msg.senderName, msg.fromMe ? 0 : 1, msg.timestamp, msg.body]
    );
    return true;
  }
  let chatMsgs = memMessages.get(msg.chatId);
  if (!chatMsgs) memMessages.set(msg.chatId, (chatMsgs = new Map()));
  if (chatMsgs.has(msg.id)) return false;
  chatMsgs.set(msg.id, msg);
  const chat = memChats.get(msg.chatId) ?? { name: "", unread: 0, lastTs: 0, lastMessage: "" };
  if (!msg.fromMe && msg.senderName) chat.name = msg.senderName;
  chat.unread = msg.fromMe ? 0 : chat.unread + 1;
  if (msg.timestamp >= chat.lastTs) {
    chat.lastTs = msg.timestamp;
    chat.lastMessage = msg.body;
  }
  memChats.set(msg.chatId, chat);
  return true;
}

async function listChats() {
  if (pool) {
    const { rows } = await pool.query(
      "select jid, name, unread, last_ts, last_message from wa_chats order by last_ts desc limit 1000"
    );
    return rows.map((r) => ({
      id: r.jid,
      name: r.name || r.jid.split("@")[0],
      lastMessage: r.last_message,
      timestamp: r.last_ts,
      unreadCount: r.unread,
    }));
  }
  return [...memChats.entries()]
    .map(([jid, c]) => ({
      id: jid,
      name: c.name || jid.split("@")[0],
      lastMessage: c.lastMessage,
      timestamp: c.lastTs,
      unreadCount: c.unread,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
}

async function listMessages(jid) {
  if (pool) {
    const { rows } = await pool.query(
      "select id, jid, body, from_me, ts, sender, status, media from wa_messages where jid = $1 order by ts asc limit 500",
      [jid]
    );
    return rows.map((r) => ({
      id: r.id,
      chatId: r.jid,
      body: r.body,
      fromMe: r.from_me,
      timestamp: r.ts,
      senderName: r.sender,
      status: r.status,
      media: r.media,
    }));
  }
  const chatMsgs = memMessages.get(jid);
  return chatMsgs ? [...chatMsgs.values()].sort((a, b) => a.timestamp - b.timestamp) : [];
}

async function deleteStoredChat(jid) {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const messageRows = await client.query(
        "select id from wa_messages where jid = $1",
        [jid]
      );
      const messageIds = messageRows.rows.map((row) => row.id);
      const mediaResult = messageIds.length
        ? await client.query("delete from wa_media where id = any($1::text[])", [messageIds])
        : { rowCount: 0 };
      const messageResult = await client.query(
        "delete from wa_messages where jid = $1",
        [jid]
      );
      const chatResult = await client.query("delete from wa_chats where jid = $1", [jid]);
      await client.query("commit");
      return {
        chats: chatResult.rowCount ?? 0,
        messages: messageResult.rowCount ?? 0,
        media: mediaResult.rowCount ?? 0,
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  const chatMsgs = memMessages.get(jid);
  let media = 0;
  for (const id of chatMsgs?.keys() ?? []) {
    if (memMedia.delete(id)) media += 1;
  }
  const messages = chatMsgs?.size ?? 0;
  memMessages.delete(jid);
  const chats = Number(memChats.delete(jid));
  return { chats, messages, media };
}

async function resetUnread(jid) {
  if (pool) {
    await pool.query("update wa_chats set unread = 0 where jid = $1", [jid]);
    return;
  }
  const chat = memChats.get(jid);
  if (chat) memChats.set(jid, { ...chat, unread: 0 });
}

// --- Auth state: Postgres-backed so a redeploy never needs a re-scan --------

async function usePostgresAuthState() {
  const legacyAuthDir = path.join(__dirname, "wa-session");
  const legacyFile = (id) => `${id}.json`.replace(/\//g, "__").replace(/:/g, "-");
  const write = async (id, value) => {
    await pool.query(
      `insert into wa_auth (id, data) values ($1, $2)
       on conflict (id) do update set data = excluded.data`,
      [id, JSON.stringify(value, BufferJSON.replacer)]
    );
  };
  const readLegacy = async (id) => {
    if (process.env.MIGRATE_FILE_AUTH !== "true") return null;
    try {
      const value = JSON.parse(
        fs.readFileSync(path.join(legacyAuthDir, legacyFile(id)), "utf8"),
        BufferJSON.reviver
      );
      await write(id, value);
      return value;
    } catch {
      return null;
    }
  };
  const read = async (id) => {
    const { rows } = await pool.query("select data from wa_auth where id = $1", [id]);
    if (rows[0]) return JSON.parse(rows[0].data, BufferJSON.reviver);
    return readLegacy(id);
  };
  const del = async (id) => pool.query("delete from wa_auth where id = $1", [id]);

  const creds = (await read("creds")) || initAuthCreds();
  return {
    state: {
      creds,
      // Keys are read and written in one round trip per call, not one per key.
      // Pairing generates 812 pre-keys inside Baileys' 30s upload timeout; at
      // one query each across the VM→Supabase hop the upload timed out, the
      // server never got the pre-keys, and no message reached the linked device.
      keys: {
        get: async (type, ids) => {
          const data = {};
          if (ids.length === 0) return data;
          const { rows } = await pool.query("select id, data from wa_auth where id = any($1::text[])", [
            ids.map((id) => `${type}-${id}`),
          ]);
          const found = new Map(rows.map((row) => [row.id, row.data]));
          for (const id of ids) {
            const raw = found.get(`${type}-${id}`);
            let value = raw ? JSON.parse(raw, BufferJSON.reviver) : await readLegacy(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value) data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const upsertIds = [];
          const upsertValues = [];
          const deleteIds = [];
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              if (value) {
                upsertIds.push(`${type}-${id}`);
                upsertValues.push(JSON.stringify(value, BufferJSON.replacer));
              } else {
                deleteIds.push(`${type}-${id}`);
              }
            }
          }
          if (upsertIds.length) {
            await pool.query(
              `insert into wa_auth (id, data)
               select * from unnest($1::text[], $2::text[])
               on conflict (id) do update set data = excluded.data`,
              [upsertIds, upsertValues]
            );
          }
          if (deleteIds.length) {
            await pool.query("delete from wa_auth where id = any($1::text[])", [deleteIds]);
          }
        },
      },
    },
    saveCreds: () => write("creds", creds),
    clear: () => pool.query("delete from wa_auth"),
  };
}

async function getAuthState() {
  if (pool) return usePostgresAuthState();
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "wa-session"));
  return {
    state,
    saveCreds,
    clear: async () => fs.rmSync(path.join(__dirname, "wa-session"), { recursive: true, force: true }),
  };
}

// --- Message normalization ----------------------------------------------------

function unwrap(content) {
  return (
    content?.ephemeralMessage?.message ||
    content?.viewOnceMessage?.message ||
    content?.viewOnceMessageV2?.message ||
    content?.documentWithCaptionMessage?.message ||
    content
  );
}

/** WebMessageInfo → our wire format, or null if it isn't a displayable chat message. */
function normalize(m) {
  const jid = m.key?.remoteJid;
  if (
    !jid ||
    isJidGroup(jid) ||
    isJidBroadcast(jid) ||
    isJidNewsletter(jid) ||
    isJidStatusBroadcast(jid)
  ) {
    return null;
  }
  const content = unwrap(m.message);
  if (!content || content.protocolMessage || content.reactionMessage) return null;
  const body =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    (content.imageMessage && "[photo]") ||
    (content.videoMessage && "[video]") ||
    (content.audioMessage && "[voice note]") ||
    (content.documentMessage && "[document]") ||
    (content.stickerMessage && "[sticker]") ||
    (content.locationMessage && "[location]") ||
    null;
  if (!body) return null;
  // Which captured-bytes kind this message carries (drives inline rendering).
  const media = content.imageMessage
    ? "image"
    : content.audioMessage
      ? "audio"
      : content.stickerMessage
        ? "sticker"
        : "";
  return {
    id: m.key.id,
    chatId: jid,
    body,
    fromMe: Boolean(m.key.fromMe),
    timestamp: Number(m.messageTimestamp || 0) * 1000 || Date.now(),
    senderName: m.pushName || "",
    status: Number(m.status ?? 0),
    media,
    // For a privacy-ID (@lid) chat, WhatsApp often sends the phone JID too.
    altJid: m.key.remoteJidAlt || "",
  };
}

/** Persist a delivery-status bump (sent → delivered → read) and tell the UI. */
async function updateMessageStatus(id, jid, status) {
  if (pool) {
    // Acks can arrive out of order — never let a "delivered" overwrite a "read".
    await pool.query("update wa_messages set status = greatest(status, $1) where id = $2", [
      status,
      id,
    ]);
  } else {
    const chatMsgs = memMessages.get(jid);
    const msg = chatMsgs?.get(id);
    if (msg) msg.status = Math.max(msg.status ?? 0, status);
  }
  io.emit("wa:update", { id, chatId: jid, status });
}

// --- Connection ----------------------------------------------------------------

let sock = null;
let activeAuth = null;
let switchingAccount = false;
let connectionGeneration = 0;
let reconnectTimer = null;
let waVersion = null;

async function getWhatsAppVersion() {
  if (waVersion) return waVersion;
  try {
    const latest = await fetchLatestBaileysVersion();
    waVersion = latest.version;
    console.log(
      `[cyborg-wa-worker] using WhatsApp Web version ${waVersion.join(".")}` +
        (latest.isLatest ? "" : " (fallback)")
    );
  } catch (err) {
    // Keep the worker reachable if the version endpoint is temporarily down.
    // A 405 clears this cache and retries the lookup on the next connection.
    waVersion = [2, 3000, 1043857760];
    console.warn(
      `[cyborg-wa-worker] version lookup failed; using fallback ${waVersion.join(".")}:`,
      err.message
    );
  }
  return waVersion;
}

async function connectToWhatsApp() {
  const generation = ++connectionGeneration;
  const [auth, version] = await Promise.all([
    getAuthState(),
    getWhatsAppVersion(),
  ]);
  activeAuth = auth;

  sock = makeWASocket({
    version,
    auth: {
      creds: auth.state.creds,
      keys: makeCacheableSignalKeyStore(auth.state.keys, logger),
    },
    logger,
    browser: Browsers.ubuntu(process.env.TENANT_NAME || "WhatsApp Funnel"),
    markOnlineOnConnect: false, // keep phone notifications ringing
    // On the next fresh relink (QR re-scan), ask the phone to dump its full
    // cached history — this backfills older chats/messages that were tagged in
    // WhatsApp but never crossed into the dashboard. The messaging-history.set
    // handler below persists whatever the phone sends (bounded by the phone's
    // own cache, typically recent months).
    syncFullHistory: true,
  });

  sock.ev.on("creds.update", auth.saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    // A manual session reset replaces the socket. Ignore late events from the
    // old socket so it cannot reconnect with credentials we just cleared.
    if (generation !== connectionGeneration) return;
    if (qr) {
      latestQr = await QRCode.toDataURL(qr, { width: 600, margin: 1 });
      io.emit("wa:qr", { qr: latestQr });
      console.log(`[cyborg-wa-worker] QR ready — scan at http://localhost:${PORT}/qr`);
    }
    if (connection === "open") {
      latestQr = null;
      setReady(true);
      console.log("[cyborg-wa-worker] WhatsApp session ready");
    }
    if (connection === "close") {
      setReady(false);
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      // WhatsApp returns 405 when the advertised Web client version is no
      // longer accepted. Refresh it before reconnecting so QR generation can
      // recover without another deployment.
      if (statusCode === 405) waVersion = null;
      if (statusCode === DisconnectReason.loggedOut) {
        console.log("[cyborg-wa-worker] Logged out from the phone — clearing session, new QR incoming");
        await auth.clear();
      } else {
        console.log(`[cyborg-wa-worker] Connection closed (${statusCode ?? "unknown"}) — reconnecting`);
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connectToWhatsApp().catch((err) =>
          console.error("[cyborg-wa-worker] reconnect failed:", err)
        );
      }, 2500);
    }
  });

  // Recent history delivered right after pairing — seed the inbox with it.
  sock.ev.on("messaging-history.set", async ({ messages = [] }) => {
    for (const m of messages) {
      const msg = normalize(m);
      if (msg) await saveMessage(msg).catch(() => {});
    }
  });

  // Delivery acks: pending → sent → delivered → read. Feeds the UI's ticks.
  sock.ev.on("messages.update", async (updates) => {
    for (const { key, update } of updates) {
      if (!key?.id || !key.remoteJid || update?.status === undefined) continue;
      if (isJidGroup(key.remoteJid) || isJidBroadcast(key.remoteJid)) continue;
      await updateMessageStatus(key.id, key.remoteJid, Number(update.status)).catch(() => {});
    }
  });

  // Baileys also emits `append` upserts while restoring history after a
  // reconnect; both kinds are persisted for the inbox.
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    for (const m of messages) {
      const msg = normalize(m);
      if (!msg) continue;
      try {
        const isNew = await saveMessage(msg);
        if (isNew) {
          emitMessage(msg);
          // Only `notify` is a live message; `append` is history being restored.
          if (type === "notify") notifyInbound(msg);
        }
      } catch (err) {
        console.error("[cyborg-wa-worker] failed to store message:", err.message);
      }
    }
  });
}

// Log out the linked device, then remove only Baileys credentials. Chat
// history and every business table intentionally remain untouched.
app.post("/logout", async (_req, res) => {
  if (switchingAccount) {
    return res.status(409).json({ error: "A WhatsApp account switch is already in progress." });
  }
  if (!activeAuth) {
    return res.status(503).json({ error: "WhatsApp is still starting. Please try again shortly." });
  }

  switchingAccount = true;
  const currentSocket = sock;
  const currentAuth = activeAuth;
  const wasReady = ready;
  // Invalidate the old connection handler before ending the socket. Without
  // this, a stale authenticated socket can immediately recreate itself and
  // leave the worker forever at { ready: false, qr: null }.
  connectionGeneration += 1;
  clearTimeout(reconnectTimer);
  latestQr = null;
  setReady(false);

  try {
    currentSocket?.ev.removeAllListeners("creds.update");
    if (wasReady && currentSocket) {
      await currentSocket.logout();
    } else if (currentSocket) {
      currentSocket.end(new Error("WhatsApp session reset requested"));
    }
    await currentAuth.clear();
    await connectToWhatsApp();
    return res.json({ ok: true });
  } catch (err) {
    console.error("[cyborg-wa-worker] account reset failed:", err);
    return res.status(500).json({ error: "Could not reset the WhatsApp session." });
  } finally {
    switchingAccount = false;
  }
});

// Cap on photos the dashboard sends out. Media is never stored.
const MAX_MEDIA_BYTES = 6 * 1024 * 1024;

// --- Routes (registered up-front; they answer 503 until the session is live) --

app.get("/chats", async (_req, res) => {
  if (!ready) return res.status(503).json({ error: "WhatsApp not linked yet — scan the QR at /qr" });
  try {
    res.json(await listChats());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/messages/:chatId", async (req, res) => {
  if (!ready) return res.status(503).json({ error: "WhatsApp not linked yet — scan the QR at /qr" });
  try {
    const messages = await listMessages(req.params.chatId);
    if (req.query.peek !== "1") await resetUnread(req.params.chatId);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete("/chats/:chatId", async (req, res) => {
  const chatId = req.params.chatId;
  try {
    const deleted = await deleteStoredChat(chatId);
    avatarCache.delete(chatId);
    io.emit("wa:chat-deleted", { chatId });
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/media/:id", async (req, res) => {
  try {
    const media = await getMedia(req.params.id);
    if (!media) return res.status(404).json({ error: "media not captured for this message" });
    res.json(media);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Mark a chat read on the phone itself — the customer sees blue ticks and the
// phone's unread badge clears, exactly like opening the chat in WhatsApp.
app.post("/read", async (req, res) => {
  if (!ready || !sock) return res.status(503).json({ error: "WhatsApp not linked yet" });
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: "chatId required" });
  try {
    await markChatReadLive(chatId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Blue ticks on the customer's phone for their latest messages, and the
// dashboard's unread badge cleared — like opening the chat in WhatsApp.
async function markChatReadLive(chatId) {
  let ids = [];
  if (pool) {
    const { rows } = await pool.query(
      "select id from wa_messages where jid = $1 and from_me = false order by ts desc limit 20",
      [chatId]
    );
    ids = rows.map((r) => r.id);
  } else {
    const chatMsgs = memMessages.get(chatId);
    if (chatMsgs) {
      ids = [...chatMsgs.values()]
        .filter((m) => !m.fromMe)
        .slice(-20)
        .map((m) => m.id);
    }
  }
  if (ids.length > 0) {
    await sock.readMessages(ids.map((id) => ({ remoteJid: chatId, id, fromMe: false })));
  }
  await resetUnread(chatId);
}

// Profile pictures, cached for 6h — WhatsApp rate-limits this lookup, and
// most avatars barely change. null = no picture / hidden by privacy settings.
const avatarCache = new Map(); // jid -> { url, ts }
app.get("/avatar/:jid", async (req, res) => {
  if (!ready || !sock) return res.status(503).json({ error: "WhatsApp not linked yet" });
  const jid = req.params.jid;
  const cached = avatarCache.get(jid);
  if (cached && Date.now() - cached.ts < 6 * 60 * 60 * 1000) return res.json({ url: cached.url });
  try {
    const url = await sock.profilePictureUrl(jid, "preview").catch(() => null);
    avatarCache.set(jid, { url: url ?? null, ts: Date.now() });
    res.json({ url: url ?? null });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Presence: show "typing…" on the customer's phone while the operator types.
app.post("/typing", async (req, res) => {
  if (!ready || !sock) return res.status(503).json({ error: "WhatsApp not linked yet" });
  const { chatId, state } = req.body;
  if (!chatId || !["composing", "paused"].includes(state)) {
    return res.status(400).json({ error: "chatId and state (composing|paused) required" });
  }
  try {
    await sock.sendPresenceUpdate(state, chatId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/send", async (req, res) => {
  if (!ready || !sock) {
    return res.status(503).json({ error: "WhatsApp not linked yet — scan the QR at /qr" });
  }
  const { chatId, text, media, expectedLatestMessageId, idempotencyKey } = req.body;
  if (!chatId || (!text && !media?.data)) {
    return res.status(400).json({ error: "chatId and text (or media) required" });
  }
  if (claimSendKey(idempotencyKey)) {
    return res.json({ ok: true, deduped: true });
  }
  try {
    if (expectedLatestMessageId) {
      const messages = await listMessages(chatId);
      const latest = messages[messages.length - 1];
      if (!latest || latest.fromMe || latest.id !== expectedLatestMessageId) {
        releaseSendKey(idempotencyKey, false);
        return res.status(409).json({ error: "A newer message superseded this AI reply" });
      }
    }
    let sent;
    let mediaBuffer = null;
    if (media?.data) {
      mediaBuffer = Buffer.from(media.data, "base64");
      if (mediaBuffer.length > MAX_MEDIA_BYTES) {
        releaseSendKey(idempotencyKey, false);
        return res.status(400).json({ error: "media too large (6 MB max)" });
      }
      sent = await sock.sendMessage(chatId, {
        image: mediaBuffer,
        mimetype: media.mime || "image/jpeg",
        caption: text || undefined,
      });
    } else {
      sent = await sock.sendMessage(chatId, { text });
    }
    // Answer as soon as WhatsApp accepts the message — persisting to Postgres
    // (2 round trips to a remote DB) happens after, so the UI isn't kept waiting.
    releaseSendKey(idempotencyKey, true);
    res.json({ ok: true });
    // messages.upsert usually echoes our own sends, but don't rely on it.
    const msg = normalize(sent);
    if (msg) {
      saveMessage(msg)
        .then((isNew) => {
          if (isNew) emitMessage(msg);
        })
        .catch((err) => console.error("[cyborg-wa-worker] failed to store sent message:", err.message));
    }
  } catch (err) {
    releaseSendKey(idempotencyKey, false);
    res.status(500).json({ error: String(err) });
  }
});

// The welcome runner's view of live WhatsApp.
waOps.read = async (chatId) => {
  if (!ready || !sock) throw new Error("WhatsApp not linked");
  await markChatReadLive(chatId);
};
waOps.typing = async (chatId, state) => {
  if (!ready || !sock) return;
  await sock.sendPresenceUpdate(state, chatId);
};
waOps.send = async (chatId, { text, image, mime }) => {
  if (!ready || !sock) throw new Error("WhatsApp not linked");
  const sent = await sock.sendMessage(
    chatId,
    image ? { image, mimetype: mime || "image/jpeg", caption: text || undefined } : { text }
  );
  const msg = normalize(sent);
  if (msg) {
    saveMessage(msg)
      .then((isNew) => {
        if (isNew) emitMessage(msg);
      })
      .catch((err) => console.error("[cyborg-wa-worker] failed to store sent message:", err.message));
  }
};

// Listen immediately — /qr and /health must be reachable before the scan.
server.listen(PORT, LISTEN_HOST, () => {
  console.log(`[cyborg-wa-worker] LIVE mode on :${PORT} (waiting for QR scan)`);
  startTrackingFallbackScheduler();
  startFollowUpScheduler();
});

ensureTables()
  .then(connectToWhatsApp)
  .catch((err) => {
    console.error("[cyborg-wa-worker] fatal startup error:", err);
    process.exit(1);
  });
