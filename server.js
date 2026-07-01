// FinTrack v4.0 — Auth com HMAC + Supabase + fallback JSON

const express = require("express");
const https   = require("https");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");

// ── .ENV LOCAL ─────────────────────────────────────────
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
      const idx = line.indexOf("=");
      if (idx > 0) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k && !process.env[k]) process.env[k] = v;
      }
    });
  }
} catch {}

const TOKEN   = process.env.TELEGRAM_TOKEN;
const PORT    = process.env.PORT || 3000;
const APP_URL = (process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || "").replace(/\/$/, "");
const SECRET  = process.env.SESSION_SECRET || "fintrack-hmac-secret-2026";
const DB_PATH = path.join(__dirname, "data.json");

// Supabase (opcional — se não configurado usa JSON file)
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const USE_SB = !!(SB_URL && SB_KEY);

// ════════════════════════════════════════════════════
//  SUPABASE REST HELPER
// ════════════════════════════════════════════════════
async function sb(table, opts = {}) {
  const { method = "GET", filter = "", body, prefer } = opts;
  const url = `${SB_URL}/rest/v1/${table}${filter ? "?" + filter : ""}`;
  const headers = {
    "apikey": SB_KEY,
    "Authorization": "Bearer " + SB_KEY,
    "Content-Type": "application/json",
  };
  if (prefer) headers["Prefer"] = prefer;

  // Node 18+ tem fetch nativo
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    console.error(`Supabase ${method} ${table}: ${res.status} ${err}`);
    return null;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ════════════════════════════════════════════════════
//  DATABASE — Supabase se disponível, senão JSON
// ════════════════════════════════════════════════════
function readJSON() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {}
  return { transactions: [], settings: { salary: 4000, wedding_goal: 15000, savings_goal: 500 }, users: [] };
}
function writeJSON(data) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch {}
}

// ─── Transactions ───────────────────────────────────
async function dbGetTransactions() {
  if (USE_SB) {
    const rows = await sb("transactions", { filter: "order=date.desc" });
    return rows || [];
  }
  return readJSON().transactions;
}
async function dbAddTransaction(tx) {
  if (USE_SB) {
    await sb("transactions", {
      method: "POST",
      body: tx,
      prefer: "return=minimal"
    });
    return;
  }
  const db = readJSON();
  db.transactions.push(tx);
  writeJSON(db);
}
async function dbDeleteTransaction(id) {
  if (USE_SB) {
    await sb("transactions", { method: "DELETE", filter: `id=eq.${encodeURIComponent(id)}` });
    return;
  }
  const db = readJSON();
  db.transactions = db.transactions.filter(t => t.id !== id);
  writeJSON(db);
}

// ─── Settings ───────────────────────────────────────
async function dbGetSettings() {
  if (USE_SB) {
    const rows = await sb("settings");
    if (rows && rows.length) {
      // key-value rows → object
      const obj = {};
      rows.forEach(r => { try { obj[r.key] = JSON.parse(r.value); } catch { obj[r.key] = r.value; } });
      return obj;
    }
    return { salary: 4000, wedding_goal: 15000, savings_goal: 500 };
  }
  return readJSON().settings || { salary: 4000, wedding_goal: 15000, savings_goal: 500 };
}
async function dbSaveSettings(cfg) {
  if (USE_SB) {
    for (const [key, value] of Object.entries(cfg)) {
      await sb("settings", {
        method: "POST",
        body: { key, value: JSON.stringify(value) },
        prefer: "resolution=merge-duplicates,return=minimal"
      });
    }
    return;
  }
  const db = readJSON();
  Object.assign(db.settings, cfg);
  writeJSON(db);
}

// ─── Users ──────────────────────────────────────────
async function dbGetUser(username) {
  if (USE_SB) {
    const rows = await sb("ft_users", { filter: `username=eq.${encodeURIComponent(username)}` });
    return rows && rows[0] ? rows[0] : null;
  }
  const db = readJSON();
  return (db.users || []).find(u => u.username === username) || null;
}
async function dbHasUsers() {
  if (USE_SB) {
    const rows = await sb("ft_users", { filter: "select=username&limit=1" });
    return rows && rows.length > 0;
  }
  const db = readJSON();
  return (db.users || []).length > 0;
}
async function dbCreateUser(username, password) {
  if (USE_SB) {
    await sb("ft_users", {
      method: "POST",
      body: { username, password },
      prefer: "return=minimal"
    });
    return;
  }
  const db = readJSON();
  if (!db.users) db.users = [];
  db.users.push({ username, password });
  writeJSON(db);
}

// ════════════════════════════════════════════════════
//  AUTH — HMAC TOKENS (sobrevivem reinícios do Render)
//  Token = base64(payload) . hmac-signature
// ════════════════════════════════════════════════════
function signToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, t: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return payload + "." + sig;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const sig     = parts.pop();
  const payload = parts.join(".");
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (Date.now() - data.t > 30 * 24 * 60 * 60 * 1000) return null;
    return data.u;
  } catch { return null; }
}

async function requireAuth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  const username = verifyToken(token);
  if (!username) return res.status(401).json({ error: "Não autenticado." });
  req.username = username;
  next();
}

// ════════════════════════════════════════════════════
//  CATEGORIES
// ════════════════════════════════════════════════════
const CAT_MAP_OUT = {
  "alimentacao": ["supermercado","mercado","ifood","restaurante","comida","almoco","jantar","cafe","padaria","lanche","pizza","extra","carrefour","atacadao","hortifruti","acougue","feira"],
  "transporte":  ["gasolina","uber","99","combustivel","estacionamento","onibus","metro","taxi","pedagio","moto","carro","financiamento moto","financiamento carro","manutencao","ipva","seguro moto","seguro carro","detran","revisao"],
  "casa":        ["aluguel","renda","luz","agua","gas","internet","condominio","moveis","limpeza","financiamento","parcela","prestacao","banco pan","pan","caixa","bradesco","itau","santander","nubank","inter","emprestimo"],
  "saude":       ["farmacia","remedio","medico","dentista","hospital","consulta","exame","clinica","plano","unimed","convenio"],
  "lazer":       ["netflix","spotify","cinema","bar","festa","viagem","hotel","jogo","steam","prime","disney","hbo","max","deezer","show","ingresso"],
  "investimento":["investimento","acao","bitcoin","cripto","etf","fundo","tesouro","cdb","xp","rico","nuinvest"],
  "casamento":   ["casamento","buffet","salao","vestido","alianca","flores","convite","lua de mel","noiva","decoracao","cerimonia"],
  "educacao":    ["curso","livro","faculdade","escola","estudo","mensalidade","udemy","alura","rocketseat","ingles"],
  "vestuario":   ["roupa","sapato","tenis","calca","camiseta","cea","renner","riachuelo","zara","moda"],
  "outros":      ["shopee","shoppe","shein","americanas","aliexpress","magazine","magalu","kabum","amazon","mercado livre","mercadolivre","olx"],
};
const CAT_MAP_IN = {
  "salario":      ["salario","salário","lustoza","empresa","grupo","pagamento","holerite","contracheque","deposito empresa"],
  "pix recebido": ["pix"],
  "freelance":    ["freelance","freela","trabalho extra","bico","servico"],
  "investimento": ["rendimento","dividendo","tesouro","lucro investimento"],
  "venda":        ["venda","vendi","vendido"],
};

function norm(s) { return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,""); }

function detectCatOut(text) {
  const t = norm(text);
  for (const [cat, kws] of Object.entries(CAT_MAP_OUT)) {
    if (kws.some(k => t.includes(norm(k)))) {
      const map = { alimentacao:"alimentação", saude:"saúde", educacao:"educação", vestuario:"vestuário" };
      return map[cat] || cat;
    }
  }
  return "outros";
}
function detectCatIn(text) {
  const t = norm(text);
  for (const [cat, kws] of Object.entries(CAT_MAP_IN)) {
    if (kws.some(k => t.includes(norm(k)))) return cat === "salario" ? "salário" : cat;
  }
  return "outros";
}

// ════════════════════════════════════════════════════
//  TELEGRAM PARSE
// ════════════════════════════════════════════════════
function parseAmount(str) {
  let s = str.replace(/R\$\s*/gi,"").trim();
  if (/\d{1,3}(\.\d{3})+,\d{1,2}/.test(s)) s = s.replace(/\./g,"").replace(",",".");
  else s = s.replace(",",".");
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}

function parseMsg(text) {
  const t  = text.trim();
  const tl = norm(t);
  const isIn = /\b(entrada|salario|salário|recebi|recebo|recebido|ganhei|credito|deposito)\b/i.test(t);
  const tipo = isIn ? "entrada" : "saida";

  const amountRx = /R?\$?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i;
  const amMatch  = t.match(amountRx);
  if (!amMatch) return null;
  const amount = parseAmount(amMatch[1] || amMatch[0]);
  if (!amount || amount <= 0) return null;

  const NOISE = /\b(entrada|saida|saída|salario|salário|recebi|recebo|ganhei|paguei|gastei|comprei|r\$|reais|mil\s+reais|mil)\b/gi;
  let desc = t.replace(amMatch[0],"").replace(NOISE," ").replace(/[-:]/g," ").replace(/\s+/g," ").trim();
  if (!desc || desc.length < 2) desc = tipo === "entrada" ? "Entrada" : "Saída";
  else desc = desc.charAt(0).toUpperCase() + desc.slice(1);

  const fullText = tl + " " + norm(desc);
  const category = tipo === "entrada" ? detectCatIn(fullText) : detectCatOut(fullText);
  const origin   = tl.includes("pix") ? "pix"
    : tipo === "entrada" ? "transferencia"
    : tl.includes("cartao")||tl.includes("credito") ? "cartao"
    : tl.includes("debito") ? "debito"
    : tl.includes("boleto") ? "boleto"
    : "outro";

  return {
    id:     Date.now().toString() + Math.random().toString(36).slice(2,5),
    tipo, date: new Date().toISOString().split("T")[0],
    amount, category, description: desc, origin, source: "telegram"
  };
}

// ════════════════════════════════════════════════════
//  TELEGRAM BOT
// ════════════════════════════════════════════════════
const ICON = {
  "alimentação":"🛒","casa":"🏠","transporte":"🚗","saúde":"💊","lazer":"🎮",
  "investimento":"📈","casamento":"💍","educação":"📚","vestuário":"👗",
  "pix recebido":"📲","salário":"💼","freelance":"🖥️","venda":"🛍️","outros":"📦"
};

function tgFetch(method, params = {}) {
  return new Promise(resolve => {
    if (!TOKEN) return resolve(null);
    const qs  = new URLSearchParams(params).toString();
    const url = `https://api.telegram.org/bot${TOKEN}/${method}?${qs}`;
    https.get(url, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on("error", () => resolve(null));
  });
}
function tgSend(chatId, text) {
  tgFetch("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}

async function handleUpdate(upd) {
  const msg = upd.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  const text   = msg.text.trim();

  if (["/start","/ajuda","/help"].includes(text)) {
    tgSend(chatId,
      "💰 <b>FinTrack Bot ativo!</b>\n\n" +
      "Envia no formato:\n" +
      "<code>Salario entrada - 4000,00 Grupo Lustoza</code>\n" +
      "<code>Saida Banco Pan: 743,00 Financiamento moto</code>\n" +
      "<code>recebi 300 pix pedro</code>\n" +
      "<code>50 supermercado</code>\n\n" +
      "Comandos:\n/resumo — resumo do mês\n/casamento — poupança casamento"
    );
    return;
  }

  if (text === "/resumo") {
    const txs = await dbGetTransactions();
    const now = new Date();
    const m = now.getMonth()+1, y = now.getFullYear();
    const mo = txs.filter(t => { const d=new Date(t.date); return d.getMonth()+1===m && d.getFullYear()===y; });
    const totalIn  = mo.filter(t=>t.tipo==="entrada").reduce((s,t)=>s+t.amount,0);
    const totalOut = mo.filter(t=>t.tipo==="saida").reduce((s,t)=>s+t.amount,0);
    tgSend(chatId,
      `📊 <b>Resumo ${now.toLocaleDateString("pt-BR",{month:"long",year:"numeric"})}</b>\n\n` +
      `↓ Entradas: <b>R$ ${totalIn.toFixed(2)}</b>\n` +
      `↑ Saídas: <b>R$ ${totalOut.toFixed(2)}</b>\n` +
      `💰 Saldo: <b>R$ ${(totalIn-totalOut).toFixed(2)}</b>`
    );
    return;
  }

  if (text === "/casamento") {
    const txs  = await dbGetTransactions();
    const cfg  = await dbGetSettings();
    const total = txs.filter(t=>t.category==="casamento").reduce((s,t)=>s+t.amount,0);
    const goal  = cfg.wedding_goal || 15000;
    tgSend(chatId,
      `💍 <b>Poupança Casamento</b>\n\n` +
      `Guardado: <b>R$ ${total.toFixed(2)}</b>\n` +
      `Meta: <b>R$ ${goal.toFixed(2)}</b>\n` +
      `Progresso: <b>${Math.min((total/goal)*100,100).toFixed(1)}%</b>\n` +
      `Falta: <b>R$ ${Math.max(goal-total,0).toFixed(2)}</b>`
    );
    return;
  }

  const tx = parseMsg(text);
  if (!tx) {
    tgSend(chatId, "❓ Não percebi.\nFormato: <code>50 supermercado</code>\nou <code>entrada 300 pix trabalho</code>");
    return;
  }
  await dbAddTransaction(tx);
  const sinal = tx.tipo === "entrada" ? "+" : "-";
  tgSend(chatId,
    `${ICON[tx.category]||"📦"} <b>Registado!</b>\n` +
    `${sinal}R$ ${tx.amount.toFixed(2).replace(".",",")} — ${tx.description}\n` +
    `📁 ${tx.category.charAt(0).toUpperCase()+tx.category.slice(1)}\n` +
    `📅 ${tx.date}`
  );
}

// ════════════════════════════════════════════════════
//  WEBHOOK / POLLING
// ════════════════════════════════════════════════════
async function setupWebhook() {
  if (!TOKEN || !APP_URL) return false;
  const webhookUrl = `${APP_URL}/telegram-webhook`;
  const res = await tgFetch("setWebhook", { url: webhookUrl, drop_pending_updates: "true" });
  if (res?.ok) { console.log(`✅ Webhook: ${webhookUrl}`); return true; }
  console.log("⚠️  Webhook falhou, polling...");
  return false;
}

let lastUpdateId = 0;
async function pollOnce() {
  const res = await tgFetch("getUpdates", { offset: lastUpdateId + 1, timeout: 20 });
  if (!res?.ok || !res.result?.length) return;
  for (const upd of res.result) {
    lastUpdateId = upd.update_id;
    await handleUpdate(upd).catch(() => {});
  }
}

// ════════════════════════════════════════════════════
//  EXPRESS
// ════════════════════════════════════════════════════
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// ── AUTH ENDPOINTS ────────────────────────────────
app.post("/api/auth/setup", async (req, res) => {
  if (await dbHasUsers()) return res.status(409).json({ error: "Conta já existe. Faz login." });
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Campos obrigatórios." });
  await dbCreateUser(username, password);
  res.json({ token: signToken(username), username });
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  // Check-only request (to detect if users exist)
  if (username === "__check__") {
    const has = await dbHasUsers();
    return res.status(has ? 401 : 404).json({ exists: has });
  }
  const user = await dbGetUser(username);
  if (!user) return res.status(404).json({ error: "Sem utilizadores. Cria uma conta." });
  if (user.password !== password) return res.status(401).json({ error: "Utilizador ou senha incorretos." });
  res.json({ token: signToken(username), username });
});

app.get("/api/auth/me", (req, res) => {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  const username = verifyToken(token);
  if (!username) return res.status(401).json({ error: "Sessão expirada." });
  res.json({ username });
});

// ── TELEGRAM WEBHOOK ─────────────────────────────
app.post("/telegram-webhook", async (req, res) => {
  res.sendStatus(200);
  if (req.body) await handleUpdate(req.body).catch(() => {});
});

app.get("/ping", (_, res) => res.send("ok"));
app.get("/api/status", (_, res) => res.json({
  ok: true, version: "4.0",
  mode: APP_URL ? "webhook" : "polling",
  db: USE_SB ? "supabase" : "json"
}));

// ── TRANSACTIONS ──────────────────────────────────
app.get("/api/transactions", requireAuth, async (req, res) => {
  const txs = await dbGetTransactions();
  const { month, year } = req.query;
  if (month && year) {
    const m = +month, y = +year;
    return res.json(txs.filter(t => {
      const d = new Date(t.date);
      return d.getMonth()+1===m && d.getFullYear()===y;
    }));
  }
  res.json(txs);
});

app.post("/api/transactions", requireAuth, async (req, res) => {
  const tx = { id: Date.now().toString() + Math.random().toString(36).slice(2,4), ...req.body };
  await dbAddTransaction(tx);
  res.status(201).json(tx);
});

app.delete("/api/transactions/:id", requireAuth, async (req, res) => {
  await dbDeleteTransaction(req.params.id);
  res.json({ ok: true });
});

// ── SETTINGS ─────────────────────────────────────
app.get("/api/settings", requireAuth, async (_, res) => res.json(await dbGetSettings()));
app.post("/api/settings", requireAuth, async (req, res) => {
  await dbSaveSettings(req.body);
  res.json(await dbGetSettings());
});

// ── STATIC ───────────────────────────────────────
const PUBLIC = path.join(__dirname);
app.get("/", (_, res) => res.sendFile(path.join(PUBLIC, "index.html")));
app.use("/node_modules", (_, res) => res.sendStatus(403));
app.use(express.static(PUBLIC, { dotfiles: "deny" }));
app.get("*", (_, res) => {
  const f = path.join(PUBLIC, "index.html");
  if (fs.existsSync(f)) return res.sendFile(f);
  res.status(404).send("index.html não encontrado");
});

// ════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`\n🚀 FinTrack v4.0 — porta ${PORT}`);
  console.log(`   DB:   ${USE_SB ? "✅ Supabase" : "⚠️  JSON local (dados perdem-se no restart)"}`);
  console.log(`   Auth: ✅ HMAC (tokens sobrevivem reinicios)`);
  console.log(`   Bot:  ${TOKEN ? "✅" : "❌ sem token"}`);

  if (!TOKEN) return;
  const useWebhook = await setupWebhook();
  if (!useWebhook) {
    console.log("🔄 Polling ativo...\n");
    (async function loop() {
      while (true) {
        await pollOnce().catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
      }
    })();
  }
});
