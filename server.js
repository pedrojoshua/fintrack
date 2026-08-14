// FinTrack v5 — gestão financeira pessoal
// Postgres + Express, registro por WhatsApp (Evolution API) e Telegram.

const express = require("express");
const path = require("path");
const fs = require("fs");

// ── .env local (em produção as variáveis vêm do ambiente) ──
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 1) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  }
} catch { /* sem .env — segue com o ambiente */ }

const db = require("./src/db");
const api = require("./src/api");
const whatsapp = require("./src/channels/whatsapp");
const telegram = require("./src/channels/telegram");

const PORT = Number(process.env.PORT) || 3000;
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "";
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));

// Cabeçalhos de segurança. A app é servida da mesma origem, por isso não há CORS:
// nenhum site externo deve poder chamar a API com o token do usuário.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

// ── Saúde ────────────────────────────────────────────
app.get("/ping", (_req, res) => res.send("ok"));
app.get("/api/status", (_req, res) =>
  res.json({
    ok: true,
    version: "5.0",
    db: "postgres",
    whatsapp: whatsapp.ENABLED,
    telegram: telegram.ENABLED,
  })
);

// ── Webhooks ─────────────────────────────────────────
// Responder 200 de imediato: a Evolution/Telegram não devem esperar pelo
// processamento, senão repetem o envio.
app.post("/webhook/whatsapp", (req, res) => {
  if (WEBHOOK_TOKEN && req.query.token !== WEBHOOK_TOKEN) return res.sendStatus(403);
  res.sendStatus(200);
  whatsapp.handleWebhook(req.body).catch((e) => console.error("webhook whatsapp:", e.message));
});

app.post("/webhook/telegram", (req, res) => {
  if (WEBHOOK_TOKEN && req.query.token !== WEBHOOK_TOKEN) return res.sendStatus(403);
  res.sendStatus(200);
  telegram.handleUpdate(req.body).catch((e) => console.error("webhook telegram:", e.message));
});

// ── API ──────────────────────────────────────────────
app.use("/api", api);

// ── Frontend ─────────────────────────────────────────
app.use(express.static(PUBLIC_DIR, { dotfiles: "deny", index: "index.html" }));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Endpoint não encontrado." });
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ── Erros ────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("Erro:", err.stack || err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: "Erro interno. Tente de novo." });
});

// ── Arranque ─────────────────────────────────────────
async function start() {
  console.log("\n🚀 FinTrack v5");
  await db.init();

  app.listen(PORT, () => console.log(`   HTTP: ✅ porta ${PORT}`));

  // WhatsApp: cria a instância e aponta o webhook para esta app.
  if (whatsapp.ENABLED) {
    const url = APP_URL
      ? `${APP_URL}/webhook/whatsapp${WEBHOOK_TOKEN ? `?token=${WEBHOOK_TOKEN}` : ""}`
      : null;
    const r = await whatsapp.ensureInstance(url);
    const state = await whatsapp.connectionState();
    console.log(`   Whats:✅ instância "${whatsapp.INSTANCE}" (${state})${url ? "" : " — sem APP_URL, webhook por definir"}`);
    if (r.error) console.log(`         ⚠️  ${r.error}`);
  } else {
    console.log("   Whats:➖ desativado (falta EVOLUTION_URL/EVOLUTION_KEY)");
  }

  // Telegram: webhook quando há APP_URL, senão polling.
  if (telegram.ENABLED) {
    let ok = false;
    if (APP_URL) {
      ok = await telegram.setupWebhook(
        `${APP_URL}/webhook/telegram${WEBHOOK_TOKEN ? `?token=${WEBHOOK_TOKEN}` : ""}`
      );
    }
    console.log(`   Tele: ✅ ${ok ? "webhook" : "polling"}`);
    if (!ok) telegram.startPolling();
  } else {
    console.log("   Tele: ➖ desativado (falta TELEGRAM_TOKEN)");
  }
  console.log("");
}

start().catch((err) => {
  console.error("✖ Arranque falhou:", err.message);
  process.exit(1);
});
