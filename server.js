// FinTrack — Servidor de Produção
// Express + API REST + Auth + Bot Telegram (webhook + polling) + Dados JSON

const express  = require("express");
const https    = require("https");
const fs       = require("fs");
const path     = require("path");
const crypto   = require("crypto");

// ── .ENV LOCAL ────────────────────────────────────────────
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
const DB_PATH = process.env.DATA_PATH || path.join(__dirname, "data.json");

// ── DATABASE (JSON FILE) ─────────────────────────────────
function readDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {}
  return {
    transactions: [],
    settings: { salary: 4000, wedding_goal: 15000, savings_goal: 500 },
    users: [],
    sessions: []
  };
}
function writeDB(data) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch {}
}

// ── AUTH HELPERS ─────────────────────────────────────────
function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function findSession(token) {
  if (!token) return null;
  const db = readDB();
  const session = (db.sessions || []).find(s => s.token === token);
  if (!session) return null;
  // Expire after 30 days
  if (Date.now() - session.createdAt > 30 * 24 * 60 * 60 * 1000) return null;
  return session;
}

function requireAuth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  const session = findSession(token);
  if (!session) return res.status(401).json({ error: "Não autenticado." });
  req.username = session.username;
  next();
}

// ── CATEGORIES ────────────────────────────────────────────
const CAT_MAP_OUT = {
  "alimentacao": ["supermercado","mercado","ifood","restaurante","comida","almoco","jantar","cafe","padaria","lanche","pizza","shoppe","shopee","shein","americanas","extra","carrefour","atacadao","hortifruti","acougue","feira"],
  "transporte":  ["gasolina","uber","99","combustivel","estacionamento","onibus","metro","taxi","pedagio","moto","carro","financiamento moto","financiamento carro","manutencao","ipva","seguro moto","seguro carro","detran","revisao"],
  "casa":        ["aluguel","renda","luz","agua","gas","internet","condominio","moveis","limpeza","financiamento","parcela","prestacao","banco pan","pan","caixa","bradesco","itau","santander","nubank","inter","emprestimo"],
  "saude":       ["farmacia","remedio","medico","dentista","hospital","consulta","exame","clinica","plano","unimed","convenio"],
  "lazer":       ["netflix","spotify","cinema","bar","festa","viagem","hotel","jogo","amazon","steam","prime","disney","hbo","max","deezer","show","ingresso"],
  "investimento":["investimento","acao","bitcoin","cripto","etf","fundo","tesouro","cdb","xp","rico","nuinvest"],
  "casamento":   ["casamento","buffet","salao","vestido","alianca","flores","convite","lua de mel","noiva","decoracao","cerimonia"],
  "educacao":    ["curso","livro","faculdade","escola","estudo","mensalidade","udemy","alura","rocketseat","inglês","ingles"],
  "vestuario":   ["roupa","sapato","tenis","calca","camiseta","cea","renner","riachuelo","zara","moda"],
};
const CAT_MAP_IN = {
  "salario":      ["salario","salário","lustoza","empresa","grupo","pagamento","holerite","contracheque","deposito empresa","dep empresa"],
  "pix recebido": ["pix"],
  "freelance":    ["freelance","freela","trabalho extra","bico","servico","servico prestado"],
  "investimento": ["rendimento","dividendo","cdb rendeu","tesouro","lucro investimento"],
  "venda":        ["venda","vendi","vendido"],
};

function normalizeStr(s) {
  return s.toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function detectCatOut(text) {
  const t = normalizeStr(text);
  for (const [cat, kws] of Object.entries(CAT_MAP_OUT)) {
    if (kws.some(k => t.includes(normalizeStr(k)))) return cat === "alimentacao" ? "alimentação"
      : cat === "saude" ? "saúde" : cat === "educacao" ? "educação" : cat === "vestuario" ? "vestuário" : cat;
  }
  return "outros";
}
function detectCatIn(text) {
  const t = normalizeStr(text);
  for (const [cat, kws] of Object.entries(CAT_MAP_IN)) {
    if (kws.some(k => t.includes(normalizeStr(k)))) return cat === "salario" ? "salário" : cat;
  }
  return "outros";
}

// ── PARSE AMOUNT ──────────────────────────────────────────
function parseAmount(str) {
  let s = str.replace(/R\$\s*/gi, "").trim();
  if (/\d{1,3}(\.\d{3})+,\d{1,2}/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(",", ".");
  }
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}

// ── PARSE TELEGRAM MESSAGE (linguagem natural) ────────────
// Exemplos aceites:
//   "Salario entrada - 4000,00 Grupo Lustoza"
//   "Saida - Shopee 81,00"
//   "Saida Banco Pan: 743,00 Financiamento moto"
//   "recebi 300 pix pedro"
//   "50 supermercado"
function parseMsg(text) {
  const t  = text.trim();
  const tl = normalizeStr(t);

  // ── 1. DETECT TYPE ──────────────────────────────────────
  const entradaRx = /\b(entrada|salario|salário|recebi|recebo|recebido|ganhei|credito|deposito)\b/i;
  const isIn      = entradaRx.test(t);
  const tipo      = isIn ? "entrada" : "saida";

  // ── 2. EXTRACT AMOUNT ───────────────────────────────────
  const amountRx = /R?\$?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i;
  const amMatch  = t.match(amountRx);
  if (!amMatch) return null;
  const amount = parseAmount(amMatch[1] || amMatch[0]);
  if (!amount || amount <= 0) return null;

  // ── 3. BUILD DESCRIPTION ────────────────────────────────
  const NOISE = /\b(entrada|saida|saída|salario|salário|recebi|recebo|ganhei|paguei|gastei|comprei|r\$|reais|mil\s+reais|mil)\b/gi;
  let desc = t
    .replace(amMatch[0], "")
    .replace(NOISE, " ")
    .replace(/[-:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!desc || desc.length < 2) desc = tipo === "entrada" ? "Entrada" : "Saída";
  else desc = desc.charAt(0).toUpperCase() + desc.slice(1);

  // ── 4. CATEGORY & ORIGIN ────────────────────────────────
  const fullText = tl + " " + normalizeStr(desc);
  const category = tipo === "entrada" ? detectCatIn(fullText) : detectCatOut(fullText);
  const origin   = tl.includes("pix") ? "pix"
    : tipo === "entrada" ? "transferencia"
    : tl.includes("cartao")||tl.includes("credito") ? "cartao"
    : tl.includes("debito") ? "debito"
    : tl.includes("boleto") ? "boleto"
    : "outro";

  return {
    id:     Date.now().toString() + Math.random().toString(36).slice(2,5),
    tipo,
    date:   new Date().toISOString().split("T")[0],
    amount,
    category,
    description: desc,
    origin,
    source: "telegram"
  };
}

// ── TELEGRAM HELPERS ──────────────────────────────────────
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
      "<code>50 supermercado</code>\n" +
      "<code>1200 aluguel</code>\n" +
      "<code>entrada 4000 salário junho</code>\n" +
      "<code>recebi 300 pix pedro</code>\n\n" +
      "Comandos:\n/resumo — resumo do mês\n/casamento — poupança casamento"
    );
    return;
  }

  if (text === "/resumo") {
    const db = readDB();
    const now = new Date();
    const m = now.getMonth()+1, y = now.getFullYear();
    const mo = db.transactions.filter(t => {
      const d = new Date(t.date);
      return d.getMonth()+1===m && d.getFullYear()===y;
    });
    const totalIn  = mo.filter(t=>t.tipo==="entrada").reduce((s,t)=>s+t.amount,0);
    const totalOut = mo.filter(t=>t.tipo==="saida").reduce((s,t)=>s+t.amount,0);
    const invest   = mo.filter(t=>t.category==="investimento").reduce((s,t)=>s+t.amount,0);
    tgSend(chatId,
      `📊 <b>Resumo ${now.toLocaleDateString("pt-BR",{month:"long",year:"numeric"})}</b>\n\n` +
      `↓ Entradas: <b>R$ ${totalIn.toFixed(2)}</b>\n` +
      `↑ Saídas: <b>R$ ${totalOut.toFixed(2)}</b>\n` +
      `📈 Investimentos: <b>R$ ${invest.toFixed(2)}</b>\n` +
      `💰 Saldo: <b>R$ ${(totalIn-totalOut).toFixed(2)}</b>`
    );
    return;
  }

  if (text === "/casamento") {
    const db = readDB();
    const total = db.transactions.filter(t=>t.category==="casamento").reduce((s,t)=>s+t.amount,0);
    const goal  = db.settings.wedding_goal || 15000;
    const pct   = Math.min((total/goal)*100,100);
    tgSend(chatId,
      `💍 <b>Poupança Casamento</b>\n\n` +
      `Guardado: <b>R$ ${total.toFixed(2)}</b>\n` +
      `Meta: <b>R$ ${goal.toFixed(2)}</b>\n` +
      `Progresso: <b>${pct.toFixed(1)}%</b>\n` +
      `Falta: <b>R$ ${Math.max(goal-total,0).toFixed(2)}</b>`
    );
    return;
  }

  const tx = parseMsg(text);
  if (!tx) {
    tgSend(chatId, "❓ Não percebi.\nFormato: <code>50 supermercado</code>\nou <code>entrada 300 pix trabalho</code>");
    return;
  }
  const db = readDB();
  db.transactions.push(tx);
  writeDB(db);
  const sinal = tx.tipo === "entrada" ? "+" : "-";
  tgSend(chatId,
    `${ICON[tx.category]||"📦"} <b>Registado!</b>\n` +
    `${sinal}R$ ${tx.amount.toFixed(2).replace(".",",")} — ${tx.description}\n` +
    `📁 ${tx.category.charAt(0).toUpperCase()+tx.category.slice(1)}\n` +
    `📅 ${tx.date}`
  );
}

// ── WEBHOOK SETUP ─────────────────────────────────────────
async function setupWebhook() {
  if (!TOKEN || !APP_URL) return false;
  const webhookUrl = `${APP_URL}/telegram-webhook`;
  const res = await tgFetch("setWebhook", { url: webhookUrl, drop_pending_updates: "true" });
  if (res?.ok) {
    console.log(`✅ Webhook registado: ${webhookUrl}`);
    return true;
  }
  console.log("⚠️  Webhook falhou, a usar polling...");
  return false;
}

// ── POLLING FALLBACK (local dev) ──────────────────────────
let lastUpdateId = 0;
async function pollOnce() {
  const res = await tgFetch("getUpdates", { offset: lastUpdateId + 1, timeout: 20 });
  if (!res?.ok || !res.result?.length) return;
  for (const upd of res.result) {
    lastUpdateId = upd.update_id;
    await handleUpdate(upd).catch(() => {});
  }
}

// ── EXPRESS ───────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// ── AUTH ROUTES ───────────────────────────────────────────
app.post("/api/auth/setup", (req, res) => {
  const db = readDB();
  if (!db.users) db.users = [];
  if (db.users.length > 0) return res.status(409).json({ error: "Conta já existe. Faz login." });

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Campos obrigatórios." });

  db.users.push({ username, password }); // password already SHA-256 from client
  const token = randomToken();
  if (!db.sessions) db.sessions = [];
  db.sessions.push({ token, username, createdAt: Date.now() });
  writeDB(db);
  res.json({ token, username });
});

app.post("/api/auth/login", (req, res) => {
  const db = readDB();
  if (!db.users || db.users.length === 0) return res.status(404).json({ error: "Sem utilizadores. Cria uma conta." });

  const { username, password } = req.body;
  const user = db.users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: "Utilizador ou senha incorretos." });

  const token = randomToken();
  if (!db.sessions) db.sessions = [];
  // Clean old sessions for this user
  db.sessions = db.sessions.filter(s => s.username !== username);
  db.sessions.push({ token, username, createdAt: Date.now() });
  writeDB(db);
  res.json({ token, username });
});

app.get("/api/auth/me", (req, res) => {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  const session = findSession(token);
  if (!session) return res.status(401).json({ error: "Não autenticado." });
  res.json({ username: session.username });
});

// ── TELEGRAM WEBHOOK ──────────────────────────────────────
app.post("/telegram-webhook", async (req, res) => {
  res.sendStatus(200);
  if (req.body) await handleUpdate(req.body).catch(() => {});
});

// Keep-alive
app.get("/ping", (_, res) => res.send("ok"));

// ── API (protegida) ───────────────────────────────────────
app.get("/api/status", (_, res) => res.json({ ok: true, version: "3.0", mode: APP_URL ? "webhook" : "polling" }));

app.get("/api/transactions", requireAuth, (req, res) => {
  const db = readDB();
  const { month, year } = req.query;
  if (month && year) {
    const m = +month, y = +year;
    return res.json(db.transactions.filter(t => {
      const d = new Date(t.date);
      return d.getMonth()+1===m && d.getFullYear()===y;
    }));
  }
  res.json(db.transactions);
});

app.post("/api/transactions", requireAuth, (req, res) => {
  const db = readDB();
  const tx = { id: Date.now().toString() + Math.random().toString(36).slice(2,4), ...req.body };
  db.transactions.push(tx);
  writeDB(db);
  res.status(201).json(tx);
});

app.delete("/api/transactions/:id", requireAuth, (req, res) => {
  const db = readDB();
  db.transactions = db.transactions.filter(t => t.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

app.get("/api/settings", requireAuth, (_, res) => res.json(readDB().settings));
app.post("/api/settings", requireAuth, (req, res) => {
  const db = readDB();
  Object.assign(db.settings, req.body);
  writeDB(db);
  res.json(db.settings);
});

app.get("/api/summary", requireAuth, (req, res) => {
  const db  = readDB();
  const now = new Date();
  const m   = +(req.query.month || now.getMonth()+1);
  const y   = +(req.query.year  || now.getFullYear());
  const mo  = db.transactions.filter(t => {
    const d = new Date(t.date);
    return d.getMonth()+1===m && d.getFullYear()===y;
  });
  const byCat = {};
  mo.forEach(t => byCat[t.category] = (byCat[t.category]||0) + t.amount);
  const totalIn  = mo.filter(t=>t.tipo==="entrada").reduce((s,t)=>s+t.amount,0);
  const totalOut = mo.filter(t=>t.tipo==="saida").reduce((s,t)=>s+t.amount,0);
  const weddingTotal = db.transactions.filter(t=>t.category==="casamento").reduce((s,t)=>s+t.amount,0);
  res.json({
    totalIn, totalOut, saldo: totalIn-totalOut,
    investments: byCat["investimento"]||0,
    wedding: { saved: weddingTotal, goal: db.settings.wedding_goal||15000 },
    by_category: byCat, settings: db.settings
  });
});

// ── STATIC FILES ──────────────────────────────────────────
const PUBLIC = path.join(__dirname);
app.get("/", (_, res) => res.sendFile(path.join(PUBLIC, "index.html")));
app.use("/node_modules", (_, res) => res.sendStatus(403));
app.use(express.static(PUBLIC, { dotfiles: "deny" }));
app.get("*", (_, res) => {
  const f = path.join(PUBLIC, "index.html");
  if (fs.existsSync(f)) return res.sendFile(f);
  res.status(404).send("FinTrack: index.html não encontrado.");
});

// ── START ─────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 FinTrack v3.0 na porta ${PORT}`);
  console.log(`   Auth: ✅ ativo`);
  console.log(`   Bot:  ${TOKEN ? "✅ configurado" : "❌ sem token"}`);

  if (!TOKEN) return;

  const useWebhook = await setupWebhook();

  if (!useWebhook) {
    console.log("🔄 Polling ativo (modo local)...\n");
    (async function loop() {
      while (true) {
        await pollOnce().catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
      }
    })();
  }
});
