// Canal WhatsApp via Evolution API.
//
// Modelo de uso: a instância é ligada ao TEU próprio número. Escrevas na
// conversa "Mensagem para mim mesmo" e o FinTrack lê e responde ali.
// Por isso só aceitamos mensagens com fromMe = true cuja conversa é o
// próprio número da instância — ninguém de fora consegue lançar nada.

const db = require("../db");
const { handleMessage, handleImage, handleAudio } = require("./handler");

const URL = (process.env.EVOLUTION_URL || "").replace(/\/$/, "");
const KEY = process.env.EVOLUTION_KEY || "";
const INSTANCE = process.env.EVOLUTION_INSTANCE || "fintrack";
const ENABLED = !!(URL && KEY);

const onlyDigits = (s) => String(s || "").replace(/\D/g, "");
const jidNumber = (jid) => onlyDigits(String(jid || "").split("@")[0].split(":")[0]);

async function evo(path, { method = "GET", body } = {}) {
  if (!ENABLED) return { ok: false, status: 0, data: null };
  try {
    const res = await fetch(`${URL}${path}`, {
      method,
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) console.error(`Evolution ${method} ${path} → ${res.status}`, String(text).slice(0, 200));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.error(`Evolution ${method} ${path} falhou:`, err.message);
    return { ok: false, status: 0, data: null };
  }
}

// ── Envio ────────────────────────────────────────────
async function sendText(number, text) {
  if (!ENABLED) return false;
  const r = await evo(`/message/sendText/${INSTANCE}`, {
    method: "POST",
    body: { number: onlyDigits(number), text },
  });
  return r.ok;
}

// ── Instância ────────────────────────────────────────
async function fetchInstance() {
  const r = await evo(`/instance/fetchInstances?instanceName=${encodeURIComponent(INSTANCE)}`);
  if (!r.ok || !r.data) return null;
  const list = Array.isArray(r.data) ? r.data : [r.data];
  // O formato varia entre versões: por vezes vem embrulhado em { instance: {...} }.
  const found = list.map((i) => i.instance || i).find((i) => (i?.instanceName || i?.name) === INSTANCE);
  return found || null;
}

async function ensureInstance(webhookUrl) {
  if (!ENABLED) return { enabled: false };

  let inst = await fetchInstance();
  if (!inst) {
    const created = await evo("/instance/create", {
      method: "POST",
      body: {
        instanceName: INSTANCE,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
        ...(webhookUrl
          ? { webhook: { url: webhookUrl, byEvents: false, base64: false, events: ["MESSAGES_UPSERT"] } }
          : {}),
      },
    });
    if (!created.ok) return { enabled: true, created: false, error: "não foi possível criar a instância" };
    inst = await fetchInstance();
  }

  if (webhookUrl) await setWebhook(webhookUrl);
  return { enabled: true, created: true, instance: INSTANCE };
}

// O formato do endpoint de webhook mudou entre versões da Evolution:
// tente o formato aninhado (v2) e cai para o plano (v1).
async function setWebhook(url) {
  const events = ["MESSAGES_UPSERT"];
  const nested = await evo(`/webhook/set/${INSTANCE}`, {
    method: "POST",
    body: { webhook: { enabled: true, url, webhookByEvents: false, webhookBase64: false, events } },
  });
  if (nested.ok) return true;

  const flat = await evo(`/webhook/set/${INSTANCE}`, {
    method: "POST",
    body: { enabled: true, url, webhook_by_events: false, events },
  });
  return flat.ok;
}

async function connectionState() {
  const r = await evo(`/instance/connectionState/${INSTANCE}`);
  return r.data?.instance?.state || r.data?.state || "desconhecido";
}

// Devolve o QR em base64 para o usuário ler com o celular.
async function getQrCode() {
  const r = await evo(`/instance/connect/${INSTANCE}`);
  if (!r.ok) return null;
  const d = r.data || {};
  const base64 = d.base64 || d.qrcode?.base64 || d.qr || null;
  if (!base64) return null;
  return base64.startsWith("data:") ? base64 : `data:image/png;base64,${base64}`;
}

async function logout() {
  await evo(`/instance/logout/${INSTANCE}`, { method: "DELETE" });
}

// Número do dono da instância (para reconhecer a conversa com você mesmo).
// Em cache: seria uma chamada HTTP por cada mensagem recebida.
let ownerCache = { number: null, at: 0 };
const OWNER_TTL = 5 * 60 * 1000;

async function ownerNumber({ fresh = false } = {}) {
  if (!fresh && ownerCache.number && Date.now() - ownerCache.at < OWNER_TTL) {
    return ownerCache.number;
  }
  const inst = await fetchInstance();
  const jid = inst?.ownerJid || inst?.owner || inst?.wuid || null;
  const number = jid ? jidNumber(jid) : null;
  if (number) ownerCache = { number, at: Date.now() };
  return number;
}

// ── Receção ──────────────────────────────────────────
// Mensagens efémeras embrulham o conteúdo real numa camada extra.
const unwrap = (m) => m?.ephemeralMessage?.message || m?.viewOnceMessageV2?.message || m || {};

function extractText(msg) {
  const m = unwrap(msg?.message);
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.documentMessage?.caption ||
    ""
  ).trim();
}

// Que tipo de média veio, se veio alguma.
function extractMedia(msg) {
  const m = unwrap(msg?.message);
  if (m.imageMessage) return { kind: "image", mimetype: m.imageMessage.mimetype || "image/jpeg" };
  if (m.audioMessage) return { kind: "audio", mimetype: m.audioMessage.mimetype || "audio/ogg" };
  // PDF de comprovante não dá para ler como imagem; só aceitamos documentos-imagem.
  if (m.documentMessage?.mimetype?.startsWith("image/")) {
    return { kind: "image", mimetype: m.documentMessage.mimetype };
  }
  return null;
}

// O webhook não traz o arquivo — pede-se à Evolution pelo id da mensagem.
async function downloadMedia(messageKey) {
  const r = await evo(`/chat/getBase64FromMediaMessage/${INSTANCE}`, {
    method: "POST",
    body: { message: { key: messageKey }, convertToMp4: false },
  });
  if (!r.ok || !r.data?.base64) return null;
  return { base64: r.data.base64, mimetype: r.data.mimetype || null };
}

// Evita processar duas vezes a mesma mensagem quando a Evolution repete o webhook.
const seen = new Map();
function alreadySeen(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > 5 * 60 * 1000) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

async function handleWebhook(payload) {
  const event = String(payload?.event || "").toLowerCase().replace(/_/g, ".");
  if (event && event !== "messages.upsert") return;

  const data = payload?.data;
  const messages = Array.isArray(data) ? data : [data];

  for (const msg of messages) {
    if (!msg?.key) continue;

    const { remoteJid, fromMe, id } = msg.key;
    if (!fromMe) continue;                                   // só o dono escreva
    if (String(remoteJid || "").includes("@g.us")) continue; // ignora grupos
    if (alreadySeen(id)) continue;

    const text = extractText(msg);
    const media = extractMedia(msg);
    if (!text && !media) continue;

    const from = jidNumber(remoteJid);
    // Conversa com você mesmo: o destinatário é o próprio número da instância.
    // Se não conseguirmos confirmar quem é o dono, ignoramos — sem esta
    // verificação, qualquer mensagem enviada a qualquer pessoa viraria um gasto.
    let owner = await ownerNumber();
    if (!owner) owner = await ownerNumber({ fresh: true });
    if (!owner) {
      console.warn("WhatsApp: dono da instância desconhecido — mensagem ignorada.");
      continue;
    }
    if (from !== owner) continue;

    const user = await resolveUser(from);
    if (!user) continue;

    try {
      let reply;

      if (media) {
        // Ler imagem ou transcrever áudio demora alguns segundos — avisa,
        // senão parece que a mensagem se perdeu.
        await sendText(from, media.kind === "image" ? "📷 Lendo…" : "🎤 Ouvindo…");

        const file = await downloadMedia(msg.key);
        if (!file) {
          reply = "⚠️ Não consegui descarregar o arquivo. Tente enviar outra vez.";
        } else if (media.kind === "image") {
          reply = await handleImage(user.id, file.base64, file.mimetype || media.mimetype, "whatsapp");
        } else {
          reply = await handleAudio(user.id, file.base64, file.mimetype || media.mimetype, "whatsapp");
        }
      } else {
        reply = await handleMessage(user.id, text, "whatsapp");
      }

      if (reply) await sendText(from, reply);
    } catch (err) {
      console.error("WhatsApp handler:", err.message);
      await sendText(from, "⚠️ Deu erro ao registrar. Tente de novo daqui a pouco.");
    }
  }
}

// Liga o número à conta. Como a instância é o próprio número do usuário e a
// app é de conta única, a primeira mensagem faz o emparelhamento.
async function resolveUser(number) {
  const linked = await db.one("SELECT id, username FROM users WHERE whatsapp_jid = $1", [number]);
  if (linked) return linked;

  const users = await db.query("SELECT id, username FROM users ORDER BY id LIMIT 2");
  if (users.length === 1) {
    await db.query("UPDATE users SET whatsapp_jid = $1 WHERE id = $2", [number, users[0].id]);
    console.log(`📱 WhatsApp conectado à conta "${users[0].username}"`);
    return users[0];
  }
  return null;
}

module.exports = {
  ENABLED, INSTANCE,
  sendText, ensureInstance, setWebhook, connectionState, getQrCode, logout,
  ownerNumber, handleWebhook,
};
