// ============================================================
// Live Chat Server v2 — with SQLite, Email Alerts, Auto-reply
// ============================================================
const WebSocket = require("ws");
const http      = require("http");
const { v4: uuidv4 } = require("uuid");

// ── Database ──────────────────────────────────────────────
let db;
try {
  const Database = require("better-sqlite3");
  db = new Database("chat.db");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      meta TEXT DEFAULT '{}',
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      role TEXT,
      text TEXT,
      ts INTEGER,
      FOREIGN KEY(session_id) REFERENCES sessions(id)
    );
    CREATE TABLE IF NOT EXISTS canned_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shortcut TEXT UNIQUE,
      text TEXT
    );
  `);
  // Seed default canned responses if empty
  const count = db.prepare("SELECT COUNT(*) as c FROM canned_responses").get();
  if (count.c === 0) {
    const ins = db.prepare("INSERT INTO canned_responses (shortcut, text) VALUES (?, ?)");
    ins.run("/hi",      "Hi there! 👋 Welcome! How can I help you today?");
    ins.run("/pricing", "You can find our pricing at https://yoursite.com/pricing — happy to walk you through any plan!");
    ins.run("/thanks",  "Thank you for reaching out! Is there anything else I can help you with?");
    ins.run("/wait",    "Just a moment, let me look into that for you! 🔍");
    ins.run("/bye",     "Thanks for chatting with us! Have a great day 😊");
  }
  console.log("✅ SQLite database ready (chat.db)");
} catch (e) {
  console.warn("⚠️  better-sqlite3 not installed — messages stored in memory only.");
  console.warn("   Run: npm install  to enable persistent storage.");
  db = null;
}

// ── Email (nodemailer) ─────────────────────────────────────
let mailer;
const EMAIL_CONFIG = {
  enabled:  process.env.EMAIL_ENABLED === "true",
  host:     process.env.SMTP_HOST     || "smtp.gmail.com",
  port:     parseInt(process.env.SMTP_PORT || "587"),
  user:     process.env.SMTP_USER     || "",
  pass:     process.env.SMTP_PASS     || "",
  from:     process.env.SMTP_FROM     || "",
  to:       process.env.ALERT_EMAIL   || "",
};

if (EMAIL_CONFIG.enabled && EMAIL_CONFIG.user) {
  try {
    const nodemailer = require("nodemailer");
    mailer = nodemailer.createTransport({
      host: EMAIL_CONFIG.host,
      port: EMAIL_CONFIG.port,
      secure: EMAIL_CONFIG.port === 465,
      auth: { user: EMAIL_CONFIG.user, pass: EMAIL_CONFIG.pass },
    });
    console.log("✅ Email alerts enabled → " + EMAIL_CONFIG.to);
  } catch (e) {
    console.warn("⚠️  nodemailer not installed. Run: npm install");
  }
}

// ── Auto-reply bot ─────────────────────────────────────────
const AUTO_REPLY_DELAY = parseInt(process.env.AUTO_REPLY_DELAY || "30000"); // 30s
const BOT_NAME = process.env.BOT_NAME || "Support Bot";
const AUTO_REPLY_MSG = process.env.AUTO_REPLY_MSG ||
  "Thanks for your message! 👋 Our team is currently away but will reply shortly. Leave your email if you'd like a follow-up!";

// ── HTTP server ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  // Health check
  if (url.pathname === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", sessions: Object.keys(sessions).length, agents: agents.size }));
    return;
  }

  // GET /canned — list canned responses
  if (url.pathname === "/canned" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    const rows = db ? db.prepare("SELECT * FROM canned_responses ORDER BY shortcut").all() : [];
    res.end(JSON.stringify(rows));
    return;
  }

  // POST /canned — add/update canned response  { shortcut, text }
  if (url.pathname === "/canned" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const { shortcut, text } = JSON.parse(body);
        if (db) {
          db.prepare("INSERT INTO canned_responses (shortcut, text) VALUES (?,?) ON CONFLICT(shortcut) DO UPDATE SET text=excluded.text")
            .run(shortcut, text);
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        notifyAgents({ type: "canned_updated" });
      } catch(e) { res.writeHead(400); res.end("Bad request"); }
    });
    return;
  }

  // DELETE /canned?id=N
  if (url.pathname === "/canned" && req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (db && id) db.prepare("DELETE FROM canned_responses WHERE id=?").run(id);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    notifyAgents({ type: "canned_updated" });
    return;
  }

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ message: "Live Chat Server v2" }));
});

// ── WebSocket ──────────────────────────────────────────────
const wss = new WebSocket.Server({ server });
const sessions = {};  // in-memory active sessions
const agents   = new Set();
const autoReplyTimers = {}; // sessionId → timer

function broadcast(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function notifyAgents(event) {
  agents.forEach(a => broadcast(a, event));
}

// Persist message to SQLite
function saveMessage(sessionId, message) {
  if (!db) return;
  db.prepare("INSERT OR IGNORE INTO messages (id, session_id, role, text, ts) VALUES (?,?,?,?,?)")
    .run(message.id, sessionId, message.role, message.text, message.ts);
}

// Load session history from DB
function loadHistory(sessionId) {
  if (!db) return [];
  return db.prepare("SELECT * FROM messages WHERE session_id=? ORDER BY ts ASC").all(sessionId);
}

// Send email alert
async function sendEmailAlert(sessionId, visitorMessage, meta) {
  if (!mailer || !EMAIL_CONFIG.to) return;
  const pageInfo = meta.page ? `Page: ${meta.page}\n` : "";
  try {
    await mailer.sendMail({
      from: EMAIL_CONFIG.from || EMAIL_CONFIG.user,
      to: EMAIL_CONFIG.to,
      subject: `💬 New chat message — Visitor ${sessionId.slice(0,6)}`,
      text: `A visitor sent a message and no agent replied within ${AUTO_REPLY_DELAY/1000}s.\n\n${pageInfo}Message: "${visitorMessage}"\n\nOpen dashboard: http://localhost:3001`,
      html: `<p>A visitor sent a message and no agent replied within <b>${AUTO_REPLY_DELAY/1000}s</b>.</p>${pageInfo ? `<p>${pageInfo}</p>` : ""}<p><b>Message:</b> "${visitorMessage}"</p><p><a href="http://localhost:3001">Open Dashboard</a></p>`,
    });
    console.log(`📧 Email alert sent for session ${sessionId.slice(0,6)}`);
  } catch (e) {
    console.error("Email error:", e.message);
  }
}

// Auto-reply bot logic
function scheduleAutoReply(sessionId) {
  clearTimeout(autoReplyTimers[sessionId]);
  // Only schedule if no agents are online
  if (agents.size === 0) {
    autoReplyTimers[sessionId] = setTimeout(() => {
      const session = sessions[sessionId];
      if (!session) return;
      const message = {
        id: uuidv4(),
        role: "bot",
        text: AUTO_REPLY_MSG,
        ts: Date.now(),
      };
      session.messages.push(message);
      saveMessage(sessionId, message);
      broadcast(session.visitor, { type: "message", message });
      notifyAgents({ type: "message", sessionId, message });
      // Send email alert
      const lastVisitorMsg = [...session.messages].reverse().find(m => m.role === "visitor");
      if (lastVisitorMsg) sendEmailAlert(sessionId, lastVisitorMsg.text, session.meta);
    }, AUTO_REPLY_DELAY);
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const role      = url.searchParams.get("role");
  const sessionId = url.searchParams.get("session") || uuidv4();

  ws._role      = role;
  ws._sessionId = sessionId;

  // ── AGENT ──
  if (role === "agent") {
    agents.add(ws);

    // Send session list
    const sessionList = Object.entries(sessions).map(([id, s]) => ({
      sessionId: id, meta: s.meta, messages: s.messages,
      active: s.visitor?.readyState === WebSocket.OPEN,
    }));
    broadcast(ws, { type: "sessions_list", sessions: sessionList });

    // Send canned responses
    const canned = db ? db.prepare("SELECT * FROM canned_responses ORDER BY shortcut").all() : [];
    broadcast(ws, { type: "canned_responses", canned });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);

        if (msg.type === "agent_message") {
          const session = sessions[msg.sessionId];
          if (!session) return;
          clearTimeout(autoReplyTimers[msg.sessionId]); // cancel auto-reply
          const message = { id: uuidv4(), role: "agent", text: msg.text, ts: Date.now() };
          session.messages.push(message);
          saveMessage(msg.sessionId, message);
          broadcast(session.visitor, { type: "message", message });
          notifyAgents({ type: "message", sessionId: msg.sessionId, message });
        }

        if (msg.type === "agent_typing") {
          const session = sessions[msg.sessionId];
          if (session) broadcast(session.visitor, { type: "agent_typing", typing: msg.typing });
        }
      } catch (e) {}
    });

    ws.on("close", () => {
      agents.delete(ws);
      // If no agents left, all pending chats may get auto-reply
    });

  // ── VISITOR ──
  } else {
    // Ensure session exists in memory
    if (!sessions[sessionId]) {
      sessions[sessionId] = { visitor: null, messages: [], meta: {} };
      // Load persisted history
      const history = loadHistory(sessionId);
      sessions[sessionId].messages = history;
    }

    // If new session, create in DB
    if (db) {
      db.prepare("INSERT OR IGNORE INTO sessions (id, meta, created_at) VALUES (?,?,?)").run(sessionId, "{}", Date.now());
    }

    const session = sessions[sessionId];
    session.visitor = ws;

    if (url.searchParams.get("page")) session.meta.page = decodeURIComponent(url.searchParams.get("page"));
    session.meta.connectedAt = Date.now();
    session.meta.sessionId   = sessionId;
    if (db) db.prepare("UPDATE sessions SET meta=? WHERE id=?").run(JSON.stringify(session.meta), sessionId);

    broadcast(ws, { type: "history", messages: session.messages, sessionId });

    notifyAgents({ type: "visitor_connected", sessionId, meta: session.meta, messages: session.messages });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);

        if (msg.type === "visitor_message") {
          const message = { id: uuidv4(), role: "visitor", text: msg.text, ts: Date.now() };
          session.messages.push(message);
          saveMessage(sessionId, message);
          broadcast(ws, { type: "message", message });
          notifyAgents({ type: "message", sessionId, message });
          scheduleAutoReply(sessionId);
        }

        if (msg.type === "visitor_typing") {
          notifyAgents({ type: "visitor_typing", sessionId, typing: msg.typing });
        }

        if (msg.type === "visitor_meta") {
          Object.assign(session.meta, msg.meta);
          if (db) db.prepare("UPDATE sessions SET meta=? WHERE id=?").run(JSON.stringify(session.meta), sessionId);
          notifyAgents({ type: "visitor_meta_update", sessionId, meta: session.meta });
        }
      } catch (e) {}
    });

    ws.on("close", () => {
      notifyAgents({ type: "visitor_disconnected", sessionId });
    });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 Live Chat Server v2 on port ${PORT}`);
  console.log(`   Visitor widget: ws://localhost:${PORT}?role=visitor`);
  console.log(`   Agent dashboard: ws://localhost:${PORT}?role=agent`);
  console.log(`   Canned API: http://localhost:${PORT}/canned`);
  console.log(`\n📌 Email alerts: set EMAIL_ENABLED=true + SMTP_* env vars`);
  console.log(`   Auto-reply after: ${AUTO_REPLY_DELAY/1000}s (no agents online)`);
});
