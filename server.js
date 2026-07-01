// FinTrack — Servidor de Produção
// Express + API REST + Bot Telegram + Dados em JSON

const express  = require("express");
const https    = require("https");
const fs       = require("fs");
const path     = require("path");

// Carregar .env local se existir
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
      const [k, ...v] = line.split("=");
      if (k && v.length) process.env[k.trim()] = v.join("=").trim();
    });
  }
} catch {}

const TOKEN   = process.env.TELEGRAM_TOKEN;
const PORT    = process.env.PORT || 3000;
const DB_PATH = process.env.DATA_PATH || path.join(__dirname, "data.json");

// ── DATABASE (JSON FILE) ─────────────────────────────────
function readDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {}
  return { transactions: [], settings: { salary: 4000, wedding_goal: 15000, savings_goal: 500 } };
}
function writeDB(data) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); } catch (e) { console.error("DB write error:", e.message); }
}

// ── CATEGORY AUTO-DETECT ─────────────────────────────────
const CAT_MAP = {
  "alimentação": ["supermercado","mercado","ifood","restaurante","comida","almoço","jantar","café","padaria","lanche","pizza","hamburguer","burger"],
  "casa":        ["aluguel","renda","luz","água","gás","internet","condomínio","móveis","limpeza","manutenção"],
  "transporte":  ["gasolina","uber","99","combustível","estacionamento","ônibus","metrô","táxi","moto","pedágio"],
  "saúde":       ["farmácia","remédio","médico","dentista","hospital","consulta","exame","clínica","plano de saúde"],
  "lazer":       ["netflix","spotify","cinema","bar","festa","viagem","hotel","jogo","amazon","steam","show"],
  "investimento":["investimento","ação","bitcoin","cripto","etf","fundo","tesouro","cdb","poupança"],
  "casamento":   ["casamento","noiva","buffet","salão","vestido","aliança","flores","convite","lua de mel"],
  "educação":    ["curso","livro","faculdade","escola","estudo","treinamento","mensalidade"],
  "vestuário":   ["roupa","sapato","tênis","calça","camiseta","shorts","loja"],
};

function detectCat(text) {
  const t = text.toLowerCase();
  for (const [cat, kws] of Object.entries(CAT_MAP)) {
    if (kws.some(k => t.includes(k))) return cat;
  }
  return "outros";
}

function parseMsg(text) {
  const t = text.trim();
  const isIn = /^(entrada|recebi|receb[ie]|recibo|ganhei)/i.test(t);
  const stripped = t.replace(/^(entrada|recebi|receb[ie]|recibo|ganhei)\s+/i, "");
  const match = stripped.match(/^([\d]+(?:[.,]\d{1,2})?)\s+(.+)/);
  if (!match) return null;

  const amount = parseFloat(match[1].replace(",", "."));
  const desc   = match[2].trim();
  const tl     = desc.toLowerCase();

  const cat = isIn
    ? (tl.includes("pix") ? "pix recebido"
      : tl.includes("salário") || tl.includes("salario") ? "salário"
      : tl.includes("freelance") || tl.includes("freela") ? "freelance"
      : tl.includes("invest") ? "investimento"
      : tl.includes("venda") ? "venda"
      : "outros")
    : detectCat(desc);

  const origin = tl.includes("pix") ? "pix"
    : isIn ? "transferencia"
    : "outro";

  return {
    id:          Date.now().toString() + Math.random().toString(36).slice(2,5),
    tipo:        isIn ? "entrada" : "saida",
    date:        new Date().toISOString().split("T")[0],
    amount,
    category:    cat,
    description: desc,
    origin,
    source:      "telegram"
  };
}

// ── TELEGRAM ─────────────────────────────────────────────
let lastUpdateId = 0;

function tgFetch(method, params = {}) {
  return new Promise((resolve) => {
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

const ICON = {
  "alimentação":"🛒","casa":"🏠","transporte":"🚗","saúde":"💊","lazer":"🎮",
  "investimento":"📈","casamento":"💍","educação":"📚","vestuário":"👗",
  "pix recebido":"📲","salário":"💼","freelance":"🖥️","venda":"🛍️","outros":"📦"
};

async function pollTelegram() {
  const res = await tgFetch("getUpdates", { offset: lastUpdateId + 1, timeout: 20 });
  if (!res?.ok || !res.result?.length) return;

  for (const upd of res.result) {
    lastUpdateId = upd.update_id;
    const msg = upd.message;
    if (!msg?.text) continue;

    const chatId = msg.chat.id;
    const text   = msg.text.trim();

    if (["/start", "/ajuda", "/help"].includes(text)) {
      tgSend(chatId, [
        "💰 <b>FinTrack Bot ativo!</b>\n",
        "Envia no formato:\n",
        "<code>50 supermercado</code>\n",
        "<code>1200 aluguel</code>\n",
        "<code>entrada 4000 salário junho</code>\n",
        "<code>recebi 300 pix pedro</code>\n",
        "\nComandos:\n/resumo — resumo do mês\n/casamento — poupança casamento"
      ].join(""));
      continue;
    }

    if (text === "/resumo") {
      const db = readDB();
      const now = new Date();
      const m = now.getMonth() + 1, y = now.getFullYear();
      const mo = db.transactions.filter(t => {
        const d = new Date(t.date);
        return d.getMonth()+1 === m && d.getFullYear() === y;
      });
      const totalIn  = mo.filter(t=>t.tipo==="entrada").reduce((s,t)=>s+t.amount,0);
      const totalOut = mo.filter(t=>t.tipo==="saida").reduce((s,t)=>s+t.amount,0);
      const saldo    = totalIn - totalOut;
      const invest   = mo.filter(t=>t.category==="investimento").reduce((s,t)=>s+t.amount,0);
      tgSend(chatId,
        `📊 <b>Resumo ${now.toLocaleDateString("pt-BR",{month:"long",year:"numeric"})}</b>\n\n` +
        `↓ Entradas: <b>R$ ${totalIn.toFixed(2)}</b>\n` +
        `↑ Saídas: <b>R$ ${totalOut.toFixed(2)}</b>\n` +
        `📈 Investimentos: <b>R$ ${invest.toFixed(2)}</b>\n` +
        `💰 Saldo: <b>R$ ${saldo.toFixed(2)}</b>`
      );
      continue;
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
      continue;
    }

    const tx = parseMsg(text);
    if (!tx) {
      tgSend(chatId, "❓ Não percebi.\nFormato: <code>50 supermercado</code>\nou <code>entrada 300 pix trabalho</code>\n\n/ajuda para ver mais exemplos.");
      continue;
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
}

// ── EXPRESS ───────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// Static files
app.use(express.static(path.join(__dirname)));

// ── API ───────────────────────────────────────────────────
app.get("/api/status", (_, res) => res.json({ ok: true, version: "2.0" }));

app.get("/api/transactions", (req, res) => {
  const db = readDB();
  const { month, year } = req.query;
  if (month && year) {
    const m = parseInt(month), y = parseInt(year);
    return res.json(db.transactions.filter(t => {
      const d = new Date(t.date);
      return d.getMonth()+1 === m && d.getFullYear() === y;
    }));
  }
  res.json(db.transactions);
});

app.post("/api/transactions", (req, res) => {
  const db = readDB();
  const tx = { id: Date.now().toString(), ...req.body };
  db.transactions.push(tx);
  writeDB(db);
  res.status(201).json(tx);
});

app.delete("/api/transactions/:id", (req, res) => {
  const db = readDB();
  db.transactions = db.transactions.filter(t => t.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

app.get("/api/settings", (_, res) => {
  res.json(readDB().settings);
});

app.post("/api/settings", (req, res) => {
  const db = readDB();
  Object.assign(db.settings, req.body);
  writeDB(db);
  res.json(db.settings);
});

app.get("/api/summary", (req, res) => {
  const db  = readDB();
  const now = new Date();
  const m   = parseInt(req.query.month) || now.getMonth() + 1;
  const y   = parseInt(req.query.year)  || now.getFullYear();

  const mo = db.transactions.filter(t => {
    const d = new Date(t.date);
    return d.getMonth()+1 === m && d.getFullYear() === y;
  });

  const byCat = {};
  mo.forEach(t => byCat[t.category] = (byCat[t.category]||0) + t.amount);

  const SKIP = ["investimento","casamento"];
  const expenses   = Object.entries(byCat).filter(([c])=>!SKIP.includes(c)&&mo.find(t=>t.category===c&&t.tipo==="saida")).reduce((s,[,v])=>s+v,0);
  const investments = byCat["investimento"] || 0;
  const wedding_m   = byCat["casamento"] || 0;

  const totalIn  = mo.filter(t=>t.tipo==="entrada").reduce((s,t)=>s+t.amount,0);
  const totalOut = mo.filter(t=>t.tipo==="saida").reduce((s,t)=>s+t.amount,0);

  const weddingTotal = db.transactions.filter(t=>t.category==="casamento").reduce((s,t)=>s+t.amount,0);

  res.json({
    totalIn, totalOut,
    saldo: totalIn - totalOut,
    investments, wedding_month: wedding_m,
    wedding: { saved: weddingTotal, goal: db.settings.wedding_goal || 15000 },
    by_category: byCat,
    settings: db.settings
  });
});

// SPA fallback
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "index.html")));

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║         FinTrack — Servidor Ativo            ║");
  console.log(`║  URL:  http://localhost:${PORT}                   ║`);
  console.log(`║  Bot:  ${TOKEN ? "✅ Token configurado" : "❌ Token não definido"}          ║`);
  console.log("╚══════════════════════════════════════════════╝");

  if (!TOKEN) {
    console.warn("\n⚠️  TELEGRAM_TOKEN não definido. Bot desativado.\n");
    return;
  }

  // Telegram polling loop
  (async function loop() {
    while (true) {
      try { await pollTelegram(); } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
  })();

  console.log("🤖 Bot Telegram ativo — a aguardar mensagens...\n");
});
