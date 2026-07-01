// FinTrack — Telegram Bridge Server
// Porta 3100 | Faz polling ao Telegram e expõe mensagens para o browser

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

// ── CONFIG ────────────────────────────────────────────────
const CFG_FILE = path.join(__dirname, "config.json");
let cfg = { token: "", chat_id: "" };
if (fs.existsSync(CFG_FILE)) {
  try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); } catch {}
}

const TOKEN = process.env.TELEGRAM_TOKEN || cfg.token;
if (!TOKEN) {
  console.error("❌  TELEGRAM_TOKEN não definido.");
  console.error("    Cria telegram-bridge/config.json com { \"token\": \"SEU_TOKEN\" }");
  console.error("    ou define a variável de ambiente TELEGRAM_TOKEN=xxx");
  process.exit(1);
}

let lastUpdateId = 0;
const pending = [];   // mensagens para o browser consumir

// ── CATEGORY DETECTION ────────────────────────────────────
const CAT_MAP = {
  alimentação: ["supermercado","mercado","ifood","restaurante","comida","almoço","jantar","café","padaria","lanche","pizza","hamburguer"],
  casa:        ["aluguel","renda","luz","água","gás","internet","condomínio","móveis","limpeza"],
  transporte:  ["gasolina","uber","99","combustível","estacionamento","ônibus","metrô","táxi","moto"],
  saúde:       ["farmácia","remédio","médico","dentista","hospital","consulta","exame","clínica"],
  lazer:       ["netflix","spotify","cinema","bar","festa","viagem","hotel","jogo","amazon","steam"],
  investimento:["investimento","ação","bitcoin","cripto","etf","fundo","tesouro","cdb"],
  casamento:   ["casamento","noiva","noivo","buffet","salão","vestido","aliança","flores","convite","lua de mel"],
  educação:    ["curso","livro","faculdade","escola","estudo","treinamento"],
  vestuário:   ["roupa","sapato","tênis","calça","camiseta","shorts"],
};

function detectCategory(text) {
  const t = text.toLowerCase();
  for (const [cat, kws] of Object.entries(CAT_MAP)) {
    if (kws.some(k => t.includes(k))) return cat;
  }
  return "outros";
}

// ── MESSAGE PARSER ────────────────────────────────────────
// Formatos:
//   "50 supermercado"            → saída 50 alimentação
//   "1200 aluguel casa"          → saída 1200 casa
//   "entrada 4000 salário"       → entrada 4000 salário
//   "recebi 300 pix pedro"       → entrada 300 pix recebido
//   "entrada 1000 investimento"  → entrada 1000 investimento

function parseMsg(text) {
  const t = text.trim();
  const isIn = /^(entrada|recebi|receb[ie]|recibo|ganhei)/i.test(t);
  const stripped = t.replace(/^(entrada|recebi|receb[ie]|recibo|ganhei)\s+/i, "");

  const match = stripped.match(/^([\d]+(?:[.,]\d{1,2})?)\s+(.+)/);
  if (!match) return null;

  const amount = parseFloat(match[1].replace(",", "."));
  const desc   = match[2].trim();
  const cat    = isIn
    ? (desc.toLowerCase().includes("pix") ? "pix recebido"
      : desc.toLowerCase().includes("salário") || desc.toLowerCase().includes("salario") ? "salário"
      : desc.toLowerCase().includes("freelance") ? "freelance"
      : desc.toLowerCase().includes("invest") ? "investimento"
      : "outros")
    : detectCategory(desc);

  const origin = isIn
    ? (desc.toLowerCase().includes("pix") ? "pix" : "transferencia")
    : (desc.toLowerCase().includes("pix") ? "pix" : "outro");

  return {
    id:          Date.now().toString() + Math.random().toString(36).slice(2,6),
    tipo:        isIn ? "entrada" : "saida",
    date:        new Date().toISOString().split("T")[0],
    amount,
    category:    cat,
    description: desc,
    origin,
    source:      "telegram"
  };
}

// ── TELEGRAM API ──────────────────────────────────────────
function tgGet(method, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const url = `https://api.telegram.org/bot${TOKEN}/${method}?${qs}`;
    https.get(url, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    }).on("error", reject);
  });
}

function tgSend(chatId, text) {
  tgGet("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" }).catch(() => {});
}

// ── POLLING LOOP ──────────────────────────────────────────
async function poll() {
  try {
    const res = await tgGet("getUpdates", { offset: lastUpdateId + 1, timeout: 20 });
    if (!res?.ok || !res.result?.length) return;

    for (const upd of res.result) {
      lastUpdateId = upd.update_id;
      const msg = upd.message;
      if (!msg?.text) continue;

      const chatId = msg.chat.id;
      const text   = msg.text.trim();

      // Comandos
      if (text === "/start" || text === "/ajuda") {
        tgSend(chatId, [
          "💰 <b>FinTrack Bot ativo!</b>\n",
          "Envia no formato:\n",
          "<code>50 supermercado</code>\n",
          "<code>1200 aluguel</code>\n",
          "<code>entrada 4000 salário junho</code>\n",
          "<code>recebi 300 pix pedro</code>\n",
          "\nComandos:\n/resumo — ver resumo\n/casamento — poupança casamento"
        ].join(""));
        continue;
      }

      if (text === "/resumo" || text === "/casamento") {
        tgSend(chatId, "📊 Abre a app para ver o resumo completo: <b>fintrack/index.html</b>");
        continue;
      }

      // Parse transação
      const tx = parseMsg(text);
      if (!tx) {
        tgSend(chatId, "❓ Não percebo. Usa:\n<code>50 supermercado</code>\nou\n<code>entrada 300 pix trabalho</code>");
        continue;
      }

      pending.push(tx);

      const icon = { alimentação:"🛒",casa:"🏠",transporte:"🚗",saúde:"💊",lazer:"🎮",
                     investimento:"📈",casamento:"💍",educação:"📚",vestuário:"👗",
                     "pix recebido":"📲",salário:"💼",freelance:"🖥️",outros:"📦" };
      const sinal = tx.tipo === "entrada" ? "+" : "-";
      tgSend(chatId,
        `${icon[tx.category]||"📦"} <b>Registado!</b>\n` +
        `${sinal}R$ ${tx.amount.toFixed(2).replace(".",",")} — ${tx.description}\n` +
        `📁 ${tx.category.charAt(0).toUpperCase()+tx.category.slice(1)}\n` +
        `📅 ${tx.date}`
      );
    }
  } catch (e) {
    // silent
  }
}

// ── HTTP SERVER (para o browser) ──────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.url === "/messages" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify(pending));
    return;
  }

  if (req.url === "/clear" && req.method === "POST") {
    pending.length = 0;
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.url === "/status" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, pending: pending.length, lastUpdateId }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
});

const PORT = 3100;
server.listen(PORT, "127.0.0.1", () => {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║     FinTrack — Telegram Bridge              ║");
  console.log("╠══════════════════════════════════════════════╣");
  console.log(`║  API local:  http://localhost:${PORT}          ║`);
  console.log("║  Status:     /status                         ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log("");
  console.log("🤖 Bot a fazer polling ao Telegram...");
  console.log("   Envia uma mensagem ao bot para testar.");
  console.log("");
});

// Polling loop
(async function loop() {
  while (true) {
    await poll();
    await new Promise(r => setTimeout(r, 1000));
  }
})();
