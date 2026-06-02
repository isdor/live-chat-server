# 💬 Live Chat System v2

A self-hosted live chat (like Drift / Intercom / Tawk.to) — works on any website including WordPress.

## Files

| File | Purpose |
|------|---------|
| `server.js` | Node.js WebSocket backend |
| `widget-demo.html` | Your website with the chat widget |
| `agent-dashboard.html` | Agent reply dashboard |
| `.env.example` | Copy to `.env` and configure |
| `package.json` | Node dependencies |

---

## ✨ Features (v2)

| Feature | Where |
|---------|-------|
| **Proactive bubble** — pops up after N seconds | Widget |
| **Persistent messages** — SQLite DB survives restarts | Server |
| **Email alerts** — email when visitor messages & you're away | Server |
| **Auto-reply bot** — instant reply when no agents online | Server |
| **Canned responses** — /shortcuts or click chips | Dashboard |
| **Typing indicators** — both directions | Widget + Dashboard |
| **Browser notifications** — native OS alerts | Dashboard |
| **Multi-visitor** — unlimited concurrent chats | Server |
| **Auto-reconnect** — both sides reconnect on drop | Both |

---

## 🚀 Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure email (optional)
```bash
cp .env.example .env
# Edit .env — set EMAIL_ENABLED=true and fill SMTP_* fields
```

### 3. Start server
```bash
node server.js
# or for auto-restart on changes:
npx nodemon server.js
```

### 4. Open dashboard
Open `agent-dashboard.html` in your browser (Tab 1).

### 5. Test widget
Open `widget-demo.html` in another tab. After 4 seconds the bubble appears.

---

## 🌐 Adding to WordPress

You do NOT need a plugin for this. Just paste the widget snippet:

### Option A — Insert Headers and Footers plugin (recommended)
1. Install the free plugin **"Insert Headers and Footers"** (WPCode)
2. Go to **Code Snippets → Header & Footer**
3. Copy everything between `<!-- ===== CHAT WIDGET ===== -->` and the closing `</div>` tag from `widget-demo.html`
4. Paste into the **Footer** section and save
5. Change `CHAT_SERVER` to your deployed server URL

### Option B — Theme editor
1. Go to **Appearance → Theme Editor → footer.php**
2. Paste the widget code just before `</body>`

### Option C — Elementor / page builders
Add an HTML widget anywhere on the page and paste the widget code.

---

## 🌐 Deploying the server

### Railway (easiest, free tier)
1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add environment variables from your `.env` file
4. Railway gives you a URL like `wss://your-app.railway.app`

### Render (also free)
1. [render.com](https://render.com) → New Web Service → Connect GitHub repo
2. Build command: `npm install`
3. Start command: `node server.js`
4. Add env vars in dashboard

### After deploying
Change this line in both HTML files:
```js
const CHAT_SERVER = "ws://localhost:3001";
// → change to your server:
const CHAT_SERVER = "wss://your-app.railway.app";
```

---

## ⚡ Canned Responses (Quick Replies)

In the dashboard, go to **Quick Replies** tab to add shortcuts.

In the chat input, type `/hi` and press Enter — it auto-fills the full response.
Or click the chips that appear above the input when you type `/`.

Default shortcuts included:
- `/hi` — Welcome greeting
- `/pricing` — Pricing page link
- `/thanks` — Thank you message
- `/wait` — "One moment" response
- `/bye` — Goodbye message

---

## 📧 Email Alerts Setup (Gmail)

1. Enable 2FA on your Google account
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
3. Create an App Password → copy it
4. In `.env`:
```
EMAIL_ENABLED=true
SMTP_USER=yourname@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx   ← the app password
ALERT_EMAIL=you@yourdomain.com
```

You'll get an email whenever a visitor messages and no agent replies within 30 seconds.

---

## 🤖 Auto-reply Bot

When **no agents are connected**, the bot sends an automatic message after `AUTO_REPLY_DELAY` milliseconds (default: 30s).

Customize in `.env`:
```
AUTO_REPLY_DELAY=30000
AUTO_REPLY_MSG=Hi! We're away right now but will reply soon. Leave your email for a follow-up!
```

The bot message appears in the widget as a green bubble so visitors know it's automated.

