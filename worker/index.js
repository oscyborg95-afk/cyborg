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
//   GET  /avatar/:jid                → { url } — profile picture (null when none/hidden)
//   POST /send { chatId, text, media? { mime, data } } → { ok }
//   POST /read { chatId }            → { ok } — mark chat read on the phone (blue ticks)
//   POST /typing { chatId, state }   → { ok } — "composing" | "paused" presence
//   POST /mock/incoming { chatId, body }   (mock mode only)
// Socket.io events: "wa:message", "wa:update" ({ id, chatId, status }),
//                   "wa:status" ({ ready }), "wa:qr" ({ qr })

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

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

const app = express();
app.use(cors());
// Base64 expands a 5 MB photo to about 6.7 MB. Keep the parser just above that
// while the /send route still enforces the decoded 6 MB media limit below.
app.use(express.json({ limit: "8mb" }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let ready = false;
let latestQr = null; // data:image/png;base64,... — the most recent QR to scan, if any

function startTrackingFallbackScheduler() {
  const url = process.env.APP_TRACKING_CRON_URL;
  const secret = process.env.CRON_SECRET;
  if (!url || !secret) {
    console.log("[cyborg-wa-worker] tracking fallback scheduler disabled (APP_TRACKING_CRON_URL / CRON_SECRET not set)");
    return;
  }
  const run = async () => {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${secret}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      console.log("[cyborg-wa-worker] tracking fallback completed");
    } catch (err) {
      console.error("[cyborg-wa-worker] tracking fallback failed:", err.message);
    }
  };
  setTimeout(run, 60_000);
  setInterval(run, 10 * 60_000);
}

function emitMessage(msg) {
  io.emit("wa:message", msg);
}

function setReady(value) {
  ready = value;
  io.emit("wa:status", { ready });
}

app.get("/health", (_req, res) => res.json({ ok: true, mode: MOCK ? "mock" : "live", ready }));

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

  app.post("/send", (req, res) => {
    const { chatId, text, media } = req.body;
    // Live WhatsApp JIDs end in @s.whatsapp.net; the mock seeds use @c.us.
    // Match by phone digits so server-side sends (alerts, broadcast) work here.
    let chat = chats.get(chatId);
    if (!chat && chatId) {
      const digits = String(chatId).split("@")[0];
      chat = [...chats.values()].find((c) => c.id.split("@")[0] === digits);
    }
    if (!chat || (!text && !media?.data)) {
      return res.status(400).json({ error: "unknown chatId or empty text" });
    }
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

  app.post("/mock/incoming", (req, res) => {
    const { chatId, body } = req.body;
    const chat = chats.get(chatId);
    if (!chat || !body) return res.status(400).json({ error: "unknown chatId or empty body" });
    const msg = {
      id: `${chatId}-${chat.messages.length}`,
      chatId,
      body,
      fromMe: false,
      timestamp: Date.now(),
      senderName: chat.name,
      status: 0,
      media: "",
    };
    chat.messages.push(msg);
    emitMessage(msg);
    res.json({ ok: true });
  });

  server.listen(PORT, () => {
    setReady(true);
    console.log(`[cyborg-wa-worker] MOCK mode on :${PORT}`);
    startTrackingFallbackScheduler();
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
  Browsers,
  downloadMediaMessage,
  isJidGroup,
  isJidBroadcast,
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
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });
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
    create table if not exists wa_media (
      id   text primary key,
      mime text not null,
      data text not null,
      ts   bigint not null
    );
  `);
  // Media feeds AI parsing and inline chat rendering — prune after 30 days
  // (the UI falls back to a "[photo]"-style placeholder once bytes are gone).
  await pool
    .query("delete from wa_media where ts < $1", [Date.now() - 30 * 24 * 60 * 60 * 1000])
    .catch(() => {});
}

// --- Media (voice notes + photos, for AI address parsing) --------------------

async function saveMedia(id, mime, buffer) {
  const data = buffer.toString("base64");
  if (pool) {
    await pool.query(
      `insert into wa_media (id, mime, data, ts) values ($1,$2,$3,$4)
       on conflict (id) do nothing`,
      [id, mime, data, Date.now()]
    );
    return;
  }
  memMedia.set(id, { mime, data });
}

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
  const read = async (id) => {
    const { rows } = await pool.query("select data from wa_auth where id = $1", [id]);
    return rows[0] ? JSON.parse(rows[0].data, BufferJSON.reviver) : null;
  };
  const write = async (id, value) => {
    await pool.query(
      `insert into wa_auth (id, data) values ($1, $2)
       on conflict (id) do update set data = excluded.data`,
      [id, JSON.stringify(value, BufferJSON.replacer)]
    );
  };
  const del = async (id) => pool.query("delete from wa_auth where id = $1", [id]);

  const creds = (await read("creds")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = await read(`${type}-${id}`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value) data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const type of Object.keys(data)) {
            for (const id of Object.keys(data[type])) {
              const value = data[type][id];
              if (value) await write(`${type}-${id}`, value);
              else await del(`${type}-${id}`);
            }
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
  if (!jid || isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid)) return null;
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

async function connectToWhatsApp() {
  const auth = await getAuthState();

  sock = makeWASocket({
    auth: {
      creds: auth.state.creds,
      keys: makeCacheableSignalKeyStore(auth.state.keys, logger),
    },
    logger,
    browser: Browsers.ubuntu("Daily Cart"),
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
      if (statusCode === DisconnectReason.loggedOut) {
        console.log("[cyborg-wa-worker] Logged out from the phone — clearing session, new QR incoming");
        await auth.clear();
      } else {
        console.log(`[cyborg-wa-worker] Connection closed (${statusCode ?? "unknown"}) — reconnecting`);
      }
      setTimeout(connectToWhatsApp, 2500);
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

  // Live messages: inbound AND outbound (including ones sent from your phone).
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages) {
      const msg = normalize(m);
      if (!msg) continue;
      try {
        const isNew = await saveMessage(msg);
        if (isNew) {
          emitMessage(msg);
          // Voice notes and photos often ARE the address — capture the bytes
          // so the AI parser can read them. Fire-and-forget; never blocks chat.
          captureMedia(m, msg).catch((err) =>
            console.error("[cyborg-wa-worker] media download failed:", err.message)
          );
        }
      } catch (err) {
        console.error("[cyborg-wa-worker] failed to store message:", err.message);
      }
    }
  });
}

// Sri Lankan customers frequently send the delivery address as a voice note or
// a photo of a handwritten note. Store inbound audio/images (base64) so the
// dashboard's "Parse from chat" can feed them to the multimodal parser.
const MAX_MEDIA_BYTES = 6 * 1024 * 1024;

async function captureMedia(rawMessage, msg) {
  const content = unwrap(rawMessage.message);
  const media = content?.audioMessage || content?.imageMessage || content?.stickerMessage;
  if (!media) return;
  if (Number(media.fileLength || 0) > MAX_MEDIA_BYTES) return; // skip huge files

  const buffer = await downloadMediaMessage(rawMessage, "buffer", {}, {
    logger,
    reuploadRequest: sock.updateMediaMessage,
  });
  if (!buffer || buffer.length > MAX_MEDIA_BYTES) return;
  // "audio/ogg; codecs=opus" → "audio/ogg" (what the AI APIs expect).
  const mime = (media.mimetype ||
    (content.audioMessage ? "audio/ogg" : content.stickerMessage ? "image/webp" : "image/jpeg"))
    .split(";")[0]
    .trim();
  await saveMedia(msg.id, mime, buffer);
}

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
    await resetUnread(req.params.chatId);
    res.json(messages);
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
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

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
  const { chatId, text, media } = req.body;
  if (!chatId || (!text && !media?.data)) {
    return res.status(400).json({ error: "chatId and text (or media) required" });
  }
  try {
    let sent;
    let mediaBuffer = null;
    if (media?.data) {
      mediaBuffer = Buffer.from(media.data, "base64");
      if (mediaBuffer.length > MAX_MEDIA_BYTES) {
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
    res.json({ ok: true });
    // messages.upsert usually echoes our own sends, but don't rely on it.
    const msg = normalize(sent);
    if (msg) {
      saveMessage(msg)
        .then((isNew) => {
          if (isNew) emitMessage(msg);
        })
        .catch((err) => console.error("[cyborg-wa-worker] failed to store sent message:", err.message));
      // Keep the sent photo's bytes so the dashboard can render it inline.
      if (mediaBuffer) {
        saveMedia(msg.id, (media.mime || "image/jpeg").split(";")[0].trim(), mediaBuffer).catch(
          () => {}
        );
      }
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Listen immediately — /qr and /health must be reachable before the scan.
server.listen(PORT, () => {
  console.log(`[cyborg-wa-worker] LIVE mode on :${PORT} (waiting for QR scan)`);
  startTrackingFallbackScheduler();
});

ensureTables()
  .then(connectToWhatsApp)
  .catch((err) => {
    console.error("[cyborg-wa-worker] fatal startup error:", err);
    process.exit(1);
  });
