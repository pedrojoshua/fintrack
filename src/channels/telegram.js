// Canal Telegram. Ao contrário do WhatsApp (conectado ao próprio número), qualquer
// pessoa pode falar com o bot — por isso a ligação exige um código gerado na app.

const db = require("../db");
const { handleMessage } = require("./handler");

const TOKEN = process.env.TELEGRAM_TOKEN || "";
const ENABLED = !!TOKEN;
const API = `https://api.telegram.org/bot${TOKEN}`;

async function tg(method, params = {}) {
  if (!ENABLED) return null;
  try {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30000),
    });
    return await res.json();
  } catch (err) {
    if (err.name !== "TimeoutError") console.error(`Telegram ${method}:`, err.message);
    return null;
  }
}

// O handler devolve *negrito* estilo WhatsApp; aqui converte-se para HTML.
function toHtml(text) {
  const escaped = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/_([^_\n]+)_/g, "<i>$1</i>");
}

const send = (chatId, text) =>
  tg("sendMessage", { chat_id: chatId, text: toHtml(text), parse_mode: "HTML" });

// ── Ligação por código ───────────────────────────────
async function tryLink(chatId, text) {
  const m = text.match(/^\/?(?:vincular|conectar|start)\s+(\d{6})$/i);
  if (!m) return false;

  const code = m[1];
  const row = await db.one(
    `SELECT user_id, value FROM settings WHERE key = 'link_code' AND value->>'code' = $1`,
    [code]
  );
  if (!row || Number(row.value.exp) < Date.now()) {
    await send(chatId, "❌ Código inválido ou expirado. Gera outro em Configurações → Telegram.");
    return true;
  }

  await db.query("UPDATE users SET telegram_chat_id = $1 WHERE id = $2", [String(chatId), row.user_id]);
  await db.query("DELETE FROM settings WHERE user_id = $1 AND key = 'link_code'", [row.user_id]);
  await send(chatId, "✅ *Conectado!* Já podes registrar gastos por aqui.\n\nEscreva /ajuda para ver como.");
  return true;
}

async function handleUpdate(update) {
  const msg = update?.message;
  const text = msg?.text?.trim();
  if (!text) return;

  const chatId = msg.chat.id;
  if (await tryLink(chatId, text)) return;

  const user = await db.one("SELECT id FROM users WHERE telegram_chat_id = $1", [String(chatId)]);
  if (!user) {
    await send(
      chatId,
      "👋 Este bot é privado.\n\nAbra o FinTrack → *Configurações* → *Telegram*, gera o código e envia-o aqui:\n`/vincular 123456`"
    );
    return;
  }

  try {
    const reply = await handleMessage(user.id, text, "telegram");
    if (reply) await send(chatId, reply);
  } catch (err) {
    console.error("Telegram handler:", err.message);
    await send(chatId, "⚠️ Deu erro ao registrar. Tente de novo daqui a pouco.");
  }
}

// ── Webhook ou polling ───────────────────────────────
async function setupWebhook(url) {
  if (!ENABLED) return false;
  const res = await tg("setWebhook", { url, drop_pending_updates: true, allowed_updates: ["message"] });
  return !!res?.ok;
}

let lastUpdateId = 0;
let polling = false;

async function startPolling() {
  if (!ENABLED || polling) return;
  polling = true;
  await tg("deleteWebhook", { drop_pending_updates: true });
  console.log("🔄 Telegram em polling");

  while (polling) {
    const res = await tg("getUpdates", { offset: lastUpdateId + 1, timeout: 25 });
    if (res?.ok && res.result?.length) {
      for (const upd of res.result) {
        lastUpdateId = upd.update_id;
        await handleUpdate(upd).catch((e) => console.error("Telegram update:", e.message));
      }
    } else {
      // Sem novidades (ou erro): pequena pausa para não martelar a API.
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

module.exports = { ENABLED, handleUpdate, setupWebhook, startPolling, send };
