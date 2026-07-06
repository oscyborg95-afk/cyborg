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
//   GET  /messages/:chatId           → [{ id, chatId, body, fromMe, timestamp, senderName }]
//   POST /send { chatId, text }      → { ok }
//   POST /mock/incoming { chatId, body }   (mock mode only)
// Socket.io events: "wa:message", "wa:status" ({ ready }), "wa:qr" ({ qr })

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
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let ready = false;
let latestQr = null; // data:image/png;base64,... — the most recent QR to scan, if any

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
    const { chatId, text } = req.body;
    const chat = chats.get(chatId);
    if (!chat || !text) return res.status(400).json({ error: "unknown chatId or empty text" });
    const msg = {
      id: `${chatId}-${chat.messages.length}`,
      chatId,
      body: text,
      fromMe: true,
      timestamp: Date.now(),
      senderName: "You",
    };
    chat.messages.push(msg);
    emitMessage(msg);
    res.json({ ok: true });
  });

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
    };
    chat.messages.push(msg);
    emitMessage(msg);
    res.json({ ok: true });
  });

  server.listen(PORT, () => {
    setReady(true);
    console.log(`[cyborg-wa-worker] MOCK mode on :${PORT}`);
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
    create index if not exists idx_wa_messages_jid_ts on wa_messages(jid, ts);
  `);
}

/** Store one normalized message. Returns false if we'd already seen it. */
async function saveMessage(msg) {
  if (pool) {
    const inserted = await pool.query(
      `insert into wa_messages (id, jid, body, from_me, ts, sender)
       values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing returning id`,
      [msg.id, msg.chatId, msg.body, msg.fromMe, msg.timestamp, msg.senderName]
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
      "select jid, name, unread, last_ts, last_message from wa_chats order by last_ts desc limit 300"
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
      "select id, jid, body, from_me, ts, sender from wa_messages where jid = $1 order by ts asc limit 500",
      [jid]
    );
    return rows.map((r) => ({
      id: r.id,
      chatId: r.jid,
      body: r.body,
      fromMe: r.from_me,
      timestamp: r.ts,
      senderName: r.sender,
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
  return {
    id: m.key.id,
    chatId: jid,
    body,
    fromMe: Boolean(m.key.fromMe),
    timestamp: Number(m.messageTimestamp || 0) * 1000 || Date.now(),
    senderName: m.pushName || "",
  };
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
    syncFullHistory: false,
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

  // Live messages: inbound AND outbound (including ones sent from your phone).
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const m of messages) {
      const msg = normalize(m);
      if (!msg) continue;
      try {
        const isNew = await saveMessage(msg);
        if (isNew) emitMessage(msg);
      } catch (err) {
        console.error("[cyborg-wa-worker] failed to store message:", err.message);
      }
    }
  });
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

app.post("/send", async (req, res) => {
  if (!ready || !sock) {
    return res.status(503).json({ error: "WhatsApp not linked yet — scan the QR at /qr" });
  }
  const { chatId, text } = req.body;
  if (!chatId || !text) return res.status(400).json({ error: "chatId and text required" });
  try {
    const sent = await sock.sendMessage(chatId, { text });
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
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Listen immediately — /qr and /health must be reachable before the scan.
server.listen(PORT, () => console.log(`[cyborg-wa-worker] LIVE mode on :${PORT} (waiting for QR scan)`));

ensureTables()
  .then(connectToWhatsApp)
  .catch((err) => {
    console.error("[cyborg-wa-worker] fatal startup error:", err);
    process.exit(1);
  });
