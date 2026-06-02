// ============================================================
// Live Chat Server v2 — Render-compatible (in-memory storage)
// ============================================================
const WebSocket = require("ws");
const http      = require("http");
const { randomUUID: uuidv4 } = require("crypto");

// ── In-memory storage ──────────────────────────────────────
// Messages are kept in memory. They survive as long as the
// server is running. Upgrade to a database later if needed.
const sessions = {};   // sessionId → { visitor, messages[], meta, active }
const agents   = new Set();
const autoReplyTimers = {};

// ── Email alerts (optional) ────────────────────────────────
let mailer = null;
const EMAIL_ENABLED = process.env.EMAIL_ENABLED === "true";

if (EMAIL_ENABLED) {
  try {
    const nodemailer = require("nodemailer");
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      secure: process.env.SMTP_PORT === "465",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    console.log("✅ Email alerts enabled → " + process.env.ALERT_EMAIL);
  } catch(e) {
    console.warn("Email setup failed:", e.message);
  }
}

// ── Auto-reply config ──────────────────────────────────────
const AUTO_REPLY_DELAY = parseInt(process.env.AUTO_REPLY_DELAY || "30000");
const AUTO_REPLY_MSG   = process.env.AUTO_REPLY_MSG ||
  "Thanks for your message! 👋 Our team is away right now but will reply shortly. Leave your email if you'd like a follow-up!";

// ── Canned responses (in-memory) ──────────────────────────
let cannedResponses = [
  { id: 1, shortcut: "/hi",      text: "Hi there! 👋 Welcome! How can I help you today?" },
  { id: 2, shortcut: "/pricing", text: "You can find our pricing at https://yoursite.com/pricing — happy to walk you through any plan!" },
  { id: 3, shortcut: "/thanks",  text: "Thank you for reaching out! Is there anything else I can help you with?" },
  { id: 4, shortcut: "/wait",    text: "Just a moment, let me look into that for you! 🔍" },
  { id: 5, shortcut: "/bye",     text: "Thanks for chatting with us! Have a great day 😊" },
];
let cannedNextId = 6;

// ── HTTP server ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", sessions: Object.keys(sessions).length, agents: agents.size }));
    return;
  }

  if (url.pathname === "/canned" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(cannedResponses));
    return;
  }

  if (url.pathname === "/canned" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const { shortcut, text } = JSON.parse(body);
        const existing = cannedResponses.find(c => c.shortcut === shortcut);
        if (existing) {
          existing.text = text;
        } else {
          cannedResponses.push({ id: cannedNextId++, shortcut, text });
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        notifyAgents({ type: "canned_updated" });
      } catch(e) { res.writeHead(400); res.end("Bad request"); }
    });
    return;
  }

  if (url.pathname === "/canned" && req.method === "DELETE") {
    const id = parseInt(url.searchParams.get("id"));
    cannedResponses = cannedResponses.filter(c => c.id !== id);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    notifyAgents({ type: "canned_updated" });
    return;
  }

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ message: "Live Chat Server v2 — Running ✅" }));
});

// ── WebSocket ──────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

function broadcast(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function notifyAgents(event) {
  agents.forEach(a => broadcast(a, event));
}

async function sendEmailAlert(sessionId, visitorMessage, meta) {
  if (!mailer || !process.env.ALERT_EMAIL) return;
  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.ALERT_EMAIL,
      subject: `💬 New chat message — Visitor ${sessionId.slice(0,6)}`,
      html: `<p>A visitor messaged and no agent replied within <b>${AUTO_REPLY_DELAY/1000}s</b>.</p>
             <p><b>Page:</b> ${meta.page || "unknown"}</p>
             <p><b>Message:</b> "${visitorMessage}"</p>`,
    });
  } catch(e) { console.error("Email error:", e.message); }
}

function scheduleAutoReply(sessionId) {
  clearTimeout(autoReplyTimers[sessionId]);
  if (agents.size === 0) {
    autoReplyTimers[sessionId] = setTimeout(() => {
      const session = sessions[sessionId];
      if (!session) return;
      const message = { id: uuidv4(), role: "bot", text: AUTO_REPLY_MSG, ts: Date.now() };
      session.messages.push(message);
      broadcast(session.visitor, { type: "message", message });
      notifyAgents({ type: "message", sessionId, message });
      const lastVisitor = [...session.messages].reverse().find(m => m.role === "visitor");
      if (lastVisitor) sendEmailAlert(sessionId, lastVisitor.text, session.meta);
    }, AUTO_REPLY_DELAY);
  }
}

wss.on("connection", (ws, req) => {
  const url       = new URL(req.url, "http://localhost");
  const role      = url.searchParams.get("role");
  const sessionId = url.searchParams.get("session") || uuidv4();

  // ── AGENT ──
  if (role === "agent") {
    agents.add(ws);

    const sessionList = Object.entries(sessions).map(([id, s]) => ({
      sessionId: id, meta: s.meta, messages: s.messages,
      active: s.visitor?.readyState === WebSocket.OPEN,
    }));
    broadcast(ws, { type: "sessions_list", sessions: sessionList });
    broadcast(ws, { type: "canned_responses", canned: cannedResponses });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "agent_message") {
          const session = sessions[msg.sessionId];
          if (!session) return;
          clearTimeout(autoReplyTimers[msg.sessionId]);
          const message = { id: uuidv4(), role: "agent", text: msg.text, ts: Date.now() };
          session.messages.push(message);
          broadcast(session.visitor, { type: "message", message });
          notifyAgents({ type: "message", sessionId: msg.sessionId, message });
        }
        if (msg.type === "agent_typing") {
          const session = sessions[msg.sessionId];
          if (session) broadcast(session.visitor, { type: "agent_typing", typing: msg.typing });
        }
      } catch(e) {}
    });

    ws.on("close", () => agents.delete(ws));

  // ── VISITOR ──
  } else {
    if (!sessions[sessionId]) {
      sessions[sessionId] = { visitor: null, messages: [], meta: {} };
    }
    const session = sessions[sessionId];
    session.visitor = ws;
    if (url.searchParams.get("page")) session.meta.page = decodeURIComponent(url.searchParams.get("page"));
    session.meta.connectedAt = Date.now();
    session.meta.sessionId   = sessionId;

    broadcast(ws, { type: "history", messages: session.messages, sessionId });
    notifyAgents({ type: "visitor_connected", sessionId, meta: session.meta, messages: session.messages });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "visitor_message") {
          const message = { id: uuidv4(), role: "visitor", text: msg.text, ts: Date.now() };
          session.messages.push(message);
          broadcast(ws, { type: "message", message });
          notifyAgents({ type: "message", sessionId, message });
          scheduleAutoReply(sessionId);
        }
        if (msg.type === "visitor_typing") {
          notifyAgents({ type: "visitor_typing", sessionId, typing: msg.typing });
        }
        if (msg.type === "visitor_meta") {
          Object.assign(session.meta, msg.meta);
          notifyAgents({ type: "visitor_meta_update", sessionId, meta: session.meta });
        }
      } catch(e) {}
    });

    ws.on("close", () => {
      notifyAgents({ type: "visitor_disconnected", sessionId });
    });
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 Live Chat Server v2 running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
});
