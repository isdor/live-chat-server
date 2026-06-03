// ============================================================
// Live Chat Server v4 — Fixed AI (Google Gemini)
// ============================================================
const WebSocket  = require("ws");
const http       = require("http");
const https      = require("https");
const { randomUUID } = require("crypto");

const PORT           = process.env.PORT || 3001;
const GEMINI_KEY     = process.env.GEMINI_API_KEY || "";
const EMAIL_ENABLED  = process.env.EMAIL_ENABLED === "true";

const sessions = {};
const agents   = new Set();
let cannedResponses = [
  { id:1, shortcut:"/hi",      text:"Hi there! 👋 How can I help you today?" },
  { id:2, shortcut:"/pricing", text:"Our prices start from $5.99 per page, depending on pages, deadline and academic level. Visit essayfreelancewriters.com/pricing for a full quote!" },
  { id:3, shortcut:"/order",   text:"You can place an order at essayfreelancewriters.com/order/login/signup — it takes less than 2 minutes!" },
  { id:4, shortcut:"/thanks",  text:"Thank you! Is there anything else I can help you with? 😊" },
  { id:5, shortcut:"/bye",     text:"Thanks for chatting! Have a great day 🎉" },
];
let cannedNextId = 6;

const AI_SYSTEM = `You are Alex, a friendly live chat support agent for Essay Freelance Writers (essayfreelancewriters.com).

SERVICES: Custom essays, research papers, dissertations, theses, case studies, coursework, editing & proofreading, citation formatting (APA, MLA, Chicago, Harvard, Turabian), admission essays, lab reports, presentations, capstone projects, term papers.

PRICING: Starting from $5.99 per page. Price depends on number of pages, deadline, and academic level (High School, Undergraduate, Masters, PhD). Deadlines: 8hrs, 24hrs, 48hrs, 3 days, 5 days, 7 days. Calculator: essayfreelancewriters.com/pricing

GUARANTEES: 100% plagiarism-free, on-time delivery, free revisions for 2 weeks, direct communication with writer.

HOW TO ORDER: essayfreelancewriters.com/order/login/signup

STRICT RULES:
- Reply in 1-3 SHORT sentences only. Never repeat yourself.
- Answer the specific question asked. Be direct and helpful.
- End with ONE relevant follow-up question or call to action.
- You are Alex, a human agent. Never say you are AI or a bot.
- Never use the same phrasing twice in a conversation.`;

// ── Gemini API call ────────────────────────────────────────
function callGemini(history, callback) {
  if (!GEMINI_KEY) {
    // No key — give a basic but varied response based on last message
    const last = history[history.length - 1]?.text?.toLowerCase() || "";
    let reply = "Our prices start from $5.99/page. The final price depends on your deadline, number of pages, and academic level. Want me to give you a specific quote?";
    if (last.includes("order") || last.includes("place")) reply = "Placing an order is easy — visit essayfreelancewriters.com/order/login/signup. It takes under 2 minutes. Want help with anything else?";
    if (last.includes("hi") || last.includes("hello")) reply = "Hello! How can I help you today?";
    if (last.includes("deadline") || last.includes("urgent")) reply = "We handle urgent orders — fastest turnaround is 8 hours! Prices vary by deadline. What's your deadline?";
    callback(null, reply);
    return;
  }

  // Only send visitor messages and bot/agent replies — build proper alternating history
  const rawHistory = history.filter(m => m.role === "visitor" || m.role === "bot" || m.role === "agent");
  
  // Convert to Gemini format and ensure strict alternation (user/model)
  const contents = [];
  for (const m of rawHistory) {
    const geminiRole = m.role === "visitor" ? "user" : "model";
    // Merge consecutive same-role messages
    if (contents.length > 0 && contents[contents.length-1].role === geminiRole) {
      contents[contents.length-1].parts[0].text += " " + m.text;
    } else {
      contents.push({ role: geminiRole, parts: [{ text: m.text }] });
    }
  }

  // Must have at least one user message
  if (contents.length === 0 || contents[0].role !== "user") {
    callback(null, "How can I help you today?");
    return;
  }

  // Keep last 10 turns max
  const trimmed = contents.slice(-10);

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: AI_SYSTEM }] },
    contents: trimmed,
    generationConfig: { maxOutputTokens: 150, temperature: 0.7 }
  });

  const options = {
    hostname: "generativelanguage.googleapis.com",
    path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
  };

  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", c => data += c);
    res.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) {
          callback(null, text);
        } else {
          console.error("Gemini bad response:", data.slice(0,400));
          callback(new Error("No text"));
        }
      } catch(e) { callback(e); }
    });
  });
  req.on("error", callback);
  req.write(body);
  req.end();
}

// ── Send AI reply ──────────────────────────────────────────
function sendAIReply(sessionId) {
  const session = sessions[sessionId];
  if (!session || !session.visitor) return;

  broadcast(session.visitor, { type: "agent_typing", typing: true });

  callGemini(session.messages, (err, reply) => {
    if (!session.visitor) return;
    broadcast(session.visitor, { type: "agent_typing", typing: false });

    if (err) {
      console.error("Gemini error:", err.message);
      // Don't send fallback if it looks like a key error — just log it
      return;
    }

    const message = { id: randomUUID(), role: "bot", text: reply, ts: Date.now() };
    session.messages.push(message);
    broadcast(session.visitor, { type: "message", message });
    notifyAgents({ type: "message", sessionId, message });
    console.log(`🤖 AI [${sessionId.slice(0,6)}]: ${reply.slice(0,80)}`);
  });
}

// ── Email ──────────────────────────────────────────────────
let mailer = null;
if (EMAIL_ENABLED && process.env.SMTP_USER) {
  try {
    const nodemailer = require("nodemailer");
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  } catch(e) {}
}
async function sendEmailAlert(sessionId, text, meta) {
  if (!mailer || !process.env.ALERT_EMAIL) return;
  try {
    await mailer.sendMail({
      from: process.env.SMTP_USER, to: process.env.ALERT_EMAIL,
      subject: `💬 New chat — Visitor ${sessionId.slice(0,6)}`,
      html: `<p>Page: <b>${meta.page||"unknown"}</b></p><p>Message: "${text}"</p>`
    });
  } catch(e) {}
}

// ── HTTP ───────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status:"ok", sessions:Object.keys(sessions).length, agents:agents.size, ai: GEMINI_KEY ? "Gemini ✅" : "no key ⚠️" }));
    return;
  }
  if (url.pathname === "/canned" && req.method === "GET") {
    res.setHeader("Content-Type","application/json"); res.end(JSON.stringify(cannedResponses)); return;
  }
  if (url.pathname === "/canned" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const { shortcut, text } = JSON.parse(body);
        const ex = cannedResponses.find(c => c.shortcut === shortcut);
        if (ex) ex.text = text; else cannedResponses.push({ id: cannedNextId++, shortcut, text });
        res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({ ok:true }));
        notifyAgents({ type:"canned_updated" });
      } catch(e) { res.writeHead(400); res.end("Bad request"); }
    }); return;
  }
  if (url.pathname === "/canned" && req.method === "DELETE") {
    const id = parseInt(url.searchParams.get("id"));
    cannedResponses = cannedResponses.filter(c => c.id !== id);
    res.setHeader("Content-Type","application/json"); res.end(JSON.stringify({ ok:true }));
    notifyAgents({ type:"canned_updated" }); return;
  }
  res.setHeader("Content-Type","application/json");
  res.end(JSON.stringify({ message:"Live Chat Server v4 ✅" }));
});

// ── WebSocket ──────────────────────────────────────────────
const wss = new WebSocket.Server({ server });
function broadcast(ws, data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function notifyAgents(e) { agents.forEach(a => broadcast(a, e)); }

wss.on("connection", (ws, req) => {
  const url       = new URL(req.url, "http://localhost");
  const role      = url.searchParams.get("role");
  const sessionId = url.searchParams.get("session") || randomUUID();

  // ── AGENT ──
  if (role === "agent") {
    agents.add(ws);
    broadcast(ws, { type:"sessions_list", sessions: Object.entries(sessions).map(([id,s]) => ({
      sessionId:id, meta:s.meta, messages:s.messages, active:s.visitor?.readyState===WebSocket.OPEN
    }))});
    broadcast(ws, { type:"canned_responses", canned:cannedResponses });

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "agent_message") {
          const s = sessions[msg.sessionId]; if (!s) return;
          const message = { id:randomUUID(), role:"agent", text:msg.text, ts:Date.now() };
          s.messages.push(message);
          broadcast(s.visitor, { type:"message", message });
          notifyAgents({ type:"message", sessionId:msg.sessionId, message });
        }
        if (msg.type === "agent_typing") {
          const s = sessions[msg.sessionId];
          if (s) broadcast(s.visitor, { type:"agent_typing", typing:msg.typing });
        }
      } catch(e) {}
    });
    ws.on("close", () => agents.delete(ws));

  // ── VISITOR ──
  } else {
    if (!sessions[sessionId]) sessions[sessionId] = { visitor:null, messages:[], meta:{}, greeted:false };
    const session = sessions[sessionId];
    session.visitor = ws;
    if (url.searchParams.get("page")) session.meta.page = decodeURIComponent(url.searchParams.get("page"));
    session.meta.connectedAt = Date.now();

    broadcast(ws, { type:"history", messages:session.messages, sessionId });
    notifyAgents({ type:"visitor_connected", sessionId, meta:session.meta, messages:session.messages });

    // ONE greeting only — skip if already sent (reconnect)
    if (!session.greeted) {
      session.greeted = true;
      setTimeout(() => {
        broadcast(ws, { type:"agent_typing", typing:true });
        setTimeout(() => {
          broadcast(ws, { type:"agent_typing", typing:false });
          const greet = { id:randomUUID(), role:"bot", ts:Date.now(),
            text:"Hi there! 👋 I'm Alex from Essay Freelance Writers. How can I help you today?" };
          session.messages.push(greet);
          broadcast(ws, { type:"message", message:greet });
          notifyAgents({ type:"message", sessionId, message:greet });
        }, 1000);
      }, 600);
    }

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "visitor_message") {
          const message = { id:randomUUID(), role:"visitor", text:msg.text, ts:Date.now() };
          session.messages.push(message);
          broadcast(ws, { type:"message", message });
          notifyAgents({ type:"message", sessionId, message });
          // AI replies after 1s
          setTimeout(() => sendAIReply(sessionId), 1000);
          sendEmailAlert(sessionId, msg.text, session.meta);
        }
        if (msg.type === "visitor_typing") {
          notifyAgents({ type:"visitor_typing", sessionId, typing:msg.typing });
        }
      } catch(e) {}
    });

    ws.on("close", () => notifyAgents({ type:"visitor_disconnected", sessionId }));
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Live Chat Server v4`);
  console.log(`   AI: ${GEMINI_KEY ? "✅ Gemini 1.5 Flash" : "⚠️  No GEMINI_API_KEY set"}`);
  console.log(`   Port: ${PORT}`);
});
