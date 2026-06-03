// ============================================================
// Live Chat Server v3 — AI-powered (Google Gemini)
// ============================================================
const WebSocket  = require("ws");
const http       = require("http");
const https      = require("https");
const { randomUUID } = require("crypto");

// ── Config ────────────────────────────────────────────────
const PORT           = process.env.PORT || 3001;
const GEMINI_KEY     = process.env.GEMINI_API_KEY || "";
const EMAIL_ENABLED  = process.env.EMAIL_ENABLED === "true";
const AI_REPLY_DELAY = 1200; // ms before AI replies (feels natural)

// ── In-memory storage ──────────────────────────────────────
const sessions = {};
const agents   = new Set();
let cannedResponses = [
  { id:1, shortcut:"/hi",      text:"Hi there! 👋 Welcome! How can I help you today?" },
  { id:2, shortcut:"/pricing", text:"Our prices start from $5.99 per page. Price depends on pages, deadline and academic level. Visit essayfreelancewriters.com/pricing for a full quote!" },
  { id:3, shortcut:"/order",   text:"You can place an order at essayfreelancewriters.com/order/login/signup — takes less than 2 minutes!" },
  { id:4, shortcut:"/thanks",  text:"Thank you for reaching out! Is there anything else I can help you with? 😊" },
  { id:5, shortcut:"/bye",     text:"Thanks for chatting with us! Have a great day 🎉" },
];
let cannedNextId = 6;

// ── AI System Prompt ───────────────────────────────────────
const AI_SYSTEM = `You are Alex, a friendly and helpful live chat support agent for Essay Freelance Writers (essayfreelancewriters.com).
You help students and professionals who need academic writing assistance. Be warm, concise, and always end with a helpful call to action.

ABOUT THE COMPANY:
- Academic writing and tutoring platform
- Expert writers help with research, writing, editing, and academic projects
- Rated 4.7 on Google, 4.5 on Yelp, 4.4 on Sitejabber
- 97.6% customer satisfaction rate
- 24/7 support available

SERVICES:
- Custom essays (all types), research papers, dissertations & theses
- Case studies, coursework, assignments, term papers
- Editing & proofreading, citation/formatting (APA, MLA, Chicago, Harvard, Turabian)
- Admission essays, book/movie reviews, lab reports, presentations
- Capstone projects, math problems, speeches, annotated bibliographies

PRICING:
- Starting from $5.99 per page
- Price depends on: pages, deadline, and academic level (High School / Undergraduate / Masters / PhD)
- Deadlines available: 8 hours, 24 hours, 48 hours, 3 days, 5 days, 7 days
- Price calculator: essayfreelancewriters.com/pricing

GUARANTEES:
- 100% plagiarism-free, original work
- On-time delivery guaranteed
- Free revisions for 2 weeks after delivery
- Direct communication with your writer
- Payments: Visa, Mastercard, Amex, UnionPay, Discover

HOW TO ORDER: essayfreelancewriters.com/order/login/signup

RULES:
- Keep replies short: 2-4 sentences max
- Always end with a question or call to action
- You are Alex, a human support agent — never say you are an AI or bot
- Never mention competitors
- If unsure about something specific, say: "Let me check that for you — you can also reach us at essayfreelancewriters.com/contact-us/"`;

// ── Call Gemini API ────────────────────────────────────────
function callGemini(history, callback) {
  if (!GEMINI_KEY) {
    callback(null, "Hi! I'm Alex from Essay Freelance Writers. We offer custom essays, research papers, dissertations and more from just $5.99/page. How can I help you today?");
    return;
  }

  // Build Gemini contents array from chat history
  // Gemini uses "user" and "model" roles
  const contents = history.slice(-16).map(m => ({
    role: m.role === "visitor" ? "user" : "model",
    parts: [{ text: m.text }]
  }));

  // Gemini requires alternating user/model — ensure it starts with user
  // and merge consecutive same-role messages
  const merged = [];
  for (const msg of contents) {
    if (merged.length > 0 && merged[merged.length-1].role === msg.role) {
      merged[merged.length-1].parts[0].text += "\n" + msg.parts[0].text;
    } else {
      merged.push({ role: msg.role, parts: [{ text: msg.parts[0].text }] });
    }
  }
  // Must start with user
  if (merged.length === 0 || merged[0].role !== "user") {
    merged.unshift({ role: "user", parts: [{ text: "Hello" }] });
  }

  const body = JSON.stringify({
    system_instruction: { parts: [{ text: AI_SYSTEM }] },
    contents: merged,
    generationConfig: {
      maxOutputTokens: 300,
      temperature: 0.7
    }
  });

  const options = {
    hostname: "generativelanguage.googleapis.com",
    path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body)
    }
  };

  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", chunk => data += chunk);
    res.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          callback(null, text.trim());
        } else {
          console.error("Gemini unexpected response:", data.slice(0, 300));
          callback(new Error("No text in response"));
        }
      } catch(e) {
        console.error("Gemini parse error:", e.message, data.slice(0,200));
        callback(e);
      }
    });
  });
  req.on("error", callback);
  req.write(body);
  req.end();
}

// ── Send AI reply to visitor ───────────────────────────────
function sendAIReply(sessionId) {
  const session = sessions[sessionId];
  if (!session || !session.visitor) return;

  // Build history for Gemini
  const history = session.messages
    .filter(m => m.role === "visitor" || m.role === "bot" || m.role === "agent")
    .map(m => ({ role: m.role, text: m.text }));

  // Show typing indicator
  broadcast(session.visitor, { type: "agent_typing", typing: true });

  callGemini(history, (err, reply) => {
    if (!session.visitor) return;
    broadcast(session.visitor, { type: "agent_typing", typing: false });

    const text = err
      ? "Thanks for your message! We offer custom essays, research papers, dissertations and more from $5.99/page. Shall I help you get started with an order?"
      : reply;

    const message = { id: randomUUID(), role: "bot", text, ts: Date.now() };
    session.messages.push(message);
    broadcast(session.visitor, { type: "message", message });
    notifyAgents({ type: "message", sessionId, message });

    if (err) console.error("Gemini error:", err.message);
    else console.log(`🤖 AI replied to ${sessionId.slice(0,6)}: ${text.slice(0,60)}...`);
  });
}

// ── Email alert ────────────────────────────────────────────
let mailer = null;
if (EMAIL_ENABLED && process.env.SMTP_USER) {
  try {
    const nodemailer = require("nodemailer");
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT || "587"),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    console.log("✅ Email alerts → " + process.env.ALERT_EMAIL);
  } catch(e) { console.warn("Email setup failed:", e.message); }
}

async function sendEmailAlert(sessionId, text, meta) {
  if (!mailer || !process.env.ALERT_EMAIL) return;
  try {
    await mailer.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.ALERT_EMAIL,
      subject: `💬 New chat — Visitor ${sessionId.slice(0,6)}`,
      html: `<p>New visitor message on <b>${meta.page||"your site"}</b>:</p><p>"${text}"</p>`
    });
  } catch(e) { console.error("Email error:", e.message); }
}

// ── HTTP server ────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status:"ok", sessions:Object.keys(sessions).length, agents:agents.size, ai: GEMINI_KEY ? "Gemini" : "no key" }));
    return;
  }

  if (url.pathname === "/canned" && req.method === "GET") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(cannedResponses)); return;
  }

  if (url.pathname === "/canned" && req.method === "POST") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const { shortcut, text } = JSON.parse(body);
        const ex = cannedResponses.find(c => c.shortcut === shortcut);
        if (ex) ex.text = text;
        else cannedResponses.push({ id: cannedNextId++, shortcut, text });
        res.setHeader("Content-Type","application/json");
        res.end(JSON.stringify({ ok:true }));
        notifyAgents({ type:"canned_updated" });
      } catch(e) { res.writeHead(400); res.end("Bad request"); }
    }); return;
  }

  if (url.pathname === "/canned" && req.method === "DELETE") {
    const id = parseInt(url.searchParams.get("id"));
    cannedResponses = cannedResponses.filter(c => c.id !== id);
    res.setHeader("Content-Type","application/json");
    res.end(JSON.stringify({ ok:true }));
    notifyAgents({ type:"canned_updated" }); return;
  }

  res.setHeader("Content-Type","application/json");
  res.end(JSON.stringify({ message:"Live Chat Server v3 — Gemini AI ✅" }));
});

// ── WebSocket ──────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

function broadcast(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function notifyAgents(event) { agents.forEach(a => broadcast(a, event)); }

wss.on("connection", (ws, req) => {
  const url       = new URL(req.url, "http://localhost");
  const role      = url.searchParams.get("role");
  const sessionId = url.searchParams.get("session") || randomUUID();

  // ── AGENT ──
  if (role === "agent") {
    agents.add(ws);
    const list = Object.entries(sessions).map(([id,s]) => ({
      sessionId:id, meta:s.meta, messages:s.messages,
      active: s.visitor?.readyState === WebSocket.OPEN
    }));
    broadcast(ws, { type:"sessions_list", sessions:list });
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
    if (!sessions[sessionId]) sessions[sessionId] = { visitor:null, messages:[], meta:{} };
    const session = sessions[sessionId];
    session.visitor = ws;

    if (url.searchParams.get("page")) session.meta.page = decodeURIComponent(url.searchParams.get("page"));
    session.meta.connectedAt = Date.now();

    broadcast(ws, { type:"history", messages:session.messages, sessionId });
    notifyAgents({ type:"visitor_connected", sessionId, meta:session.meta, messages:session.messages });

    // AI greeting on first visit
    if (session.messages.length === 0) {
      setTimeout(() => {
        broadcast(ws, { type:"agent_typing", typing:true });
        setTimeout(() => {
          broadcast(ws, { type:"agent_typing", typing:false });
          const greet = { id:randomUUID(), role:"bot", ts:Date.now(),
            text:"Hi there! 👋 I'm Alex from Essay Freelance Writers. How can I help you today? Whether it's an essay, research paper, dissertation or any other assignment — I'm here to help!" };
          session.messages.push(greet);
          broadcast(ws, { type:"message", message:greet });
          notifyAgents({ type:"message", sessionId, message:greet });
        }, 1200);
      }, 800);
    }

    ws.on("message", raw => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === "visitor_message") {
          const message = { id:randomUUID(), role:"visitor", text:msg.text, ts:Date.now() };
          session.messages.push(message);
          broadcast(ws, { type:"message", message });
          notifyAgents({ type:"message", sessionId, message });
          // AI reply after short delay
          setTimeout(() => sendAIReply(sessionId), AI_REPLY_DELAY);
          // Email alert
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
  console.log(`\n🚀 Live Chat Server v3 — Gemini AI`);
  console.log(`   Port: ${PORT}`);
  console.log(`   AI: ${GEMINI_KEY ? "✅ Gemini 1.5 Flash enabled" : "⚠️  No GEMINI_API_KEY — using fallback replies"}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
