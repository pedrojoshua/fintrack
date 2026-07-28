// Interpreta mensagens em português livre e devolve um movimento estruturado.
// Usado tanto pelo WhatsApp como pelo Telegram.

const { norm, detectOut, detectIn, detectOrigin } = require("./categories");

// ── Valor ────────────────────────────────────────────
// Aceita "50", "1250,90", "1.250,90", "1250.90", "2 mil", "1,5k".
function parseNumber(raw) {
  let s = String(raw).trim();
  const hasDot = s.includes(".");
  const hasComma = s.includes(",");

  if (hasDot && hasComma) {
    // "1.250,90" → ponto é milhar, vírgula é decimal
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    s = s.replace(",", ".");
  } else if (hasDot) {
    // "1.250" é milhar; "1.5" é decimal
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

const MONEY_RX = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(k\b|mil\b)?/i;

function extractAmount(text) {
  const m = text.match(MONEY_RX);
  if (!m) return null;
  let value = parseNumber(m[1]);
  if (value === null) return null;
  if (m[2]) value *= 1000; // "2 mil" / "1,5k"
  if (!(value > 0)) return null;
  return { value, raw: m[0] };
}

// ── Data ─────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function extractDate(text) {
  const t = norm(text);
  const today = new Date();

  const shift = (days) => {
    const d = new Date(today);
    d.setDate(d.getDate() - days);
    return d;
  };

  if (/\banteontem\b/.test(t)) return { date: iso(shift(2)), raw: text.match(/anteontem/i)[0] };
  if (/\bontem\b/.test(t))     return { date: iso(shift(1)), raw: text.match(/ontem/i)[0] };
  if (/\bhoje\b/.test(t))      return { date: iso(today),    raw: text.match(/hoje/i)[0] };

  // "12/03", "12/03/2026", "12-03"
  const dm = text.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (dm) {
    const day = +dm[1];
    const month = +dm[2];
    let year = dm[3] ? +dm[3] : today.getFullYear();
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      return { date: `${year}-${pad(month)}-${pad(day)}`, raw: dm[0] };
    }
  }

  // "dia 12"
  const dd = text.match(/\bdia\s+(\d{1,2})\b/i);
  if (dd) {
    const day = +dd[1];
    if (day >= 1 && day <= 31) {
      return { date: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(day)}`, raw: dd[0] };
    }
  }

  return { date: iso(today), raw: null };
}

// ── Tipo de movimento ────────────────────────────────
const RX_RENDIMENTO = /\b(rendeu|rendimento|rendimentos|juros|dividendo|dividendos|proventos|jcp)\b/i;
const RX_RESGATE    = /\b(resgatei|resgate|resgatar|retirei|retirada|tirei|saquei|saque)\b/i;
const RX_APORTE     = /\b(guardei|guardar|poupei|poupar|investi|investir|apliquei|aplicar|aporte|aportei|separei)\b/i;
// "saldo"/"saldo atual" contam como entrada: é dinheiro que está com a pessoa,
// não uma despesa.
const RX_ENTRADA    = /\b(entrada|entrou|recebi|recebido|recebimento|ganhei|salario|salário|deposito|depósito|depositaram|caiu|creditou|credito na conta|saldo|sobrou|sobra|tenho|possuo|positivo)\b/i;

function detectTipo(text) {
  if (RX_RENDIMENTO.test(text)) return "rendimento";
  if (RX_RESGATE.test(text))    return "resgate";
  if (RX_APORTE.test(text))     return "aporte";
  if (RX_ENTRADA.test(text))    return "entrada";
  return "saida";
}

// ── Conta de destino (para aporte/resgate/rendimento) ─
// "guardei 500 na reserva" → hint "reserva"
// "investi 1000 no tesouro direto" → hint "tesouro direto"
function extractAccountHint(text) {
  const m = text.match(/\b(?:n[ao]s?|d[ao]s?|para\s+[ao]?s?|em)\s+([\p{L}\p{N} ]{2,40})$/iu);
  if (m) return m[1].trim();
  const m2 = text.match(/\b(?:n[ao]s?|d[ao]s?|para\s+[ao]?s?|em)\s+([\p{L}\p{N}]+(?:\s+[\p{L}\p{N}]+)?)/iu);
  return m2 ? m2[1].trim() : null;
}

// Escolhe a conta cujo nome melhor casa com o hint.
function matchAccount(hint, accounts) {
  if (!accounts.length) return null;
  if (!hint) {
    // Sem pista: se só existe uma conta, é essa.
    return accounts.length === 1 ? accounts[0] : null;
  }
  const h = norm(hint);
  let best = null;
  let bestScore = 0;
  for (const acc of accounts) {
    const n = norm(acc.name);
    let score = 0;
    if (n === h) score = 100;
    else if (n.includes(h) || h.includes(n)) score = 60 + Math.min(n.length, h.length);
    else {
      // palavras em comum
      const words = new Set(n.split(/\s+/));
      const common = h.split(/\s+/).filter((w) => w.length > 2 && words.has(w));
      score = common.length * 20;
    }
    // "reserva" sozinho aponta para a conta de reserva
    if (score === 0 && h.includes("reserva") && acc.kind === "reserva") score = 50;
    if (score > bestScore) { bestScore = score; best = acc; }
  }
  return bestScore >= 20 ? best : null;
}

// ── Limpeza da descrição ─────────────────────────────
const NOISE = new RegExp(
  "\\b(" +
  "entrada|saida|saída|salario|salário|recebi|recebido|recebemos|ganhei|paguei|pagar|gastei|gasto|" +
  // "reias"/"reias" são erros de digitação comuns no telemóvel
  "comprei|compra|reais|reias|reai|real|rs|conta|de|do|da|dos|das|no|na|nos|nas|em|com|por|pra|para|o|a|os|as|um|uma|" +
  "guardei|guardar|poupei|investi|investir|apliquei|aporte|aportei|separei|" +
  "resgatei|resgate|retirei|tirei|saquei|rendeu|rendimento|juros|" +
  "deposito|depósito|caiu|foi|fiz|" +
  "hoje|ontem|anteontem|dia" +
  ")\\b", "gi"
);

function cleanDescription(text) {
  let d = text
    .replace(/r\$/gi, " ")
    .replace(NOISE, " ")
    .replace(/[-:;,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (d.length < 2) return "";
  return d.charAt(0).toUpperCase() + d.slice(1);
}

/**
 * Interpreta a mensagem.
 * @param {string} text  mensagem crua
 * @param {Array}  accounts contas do utilizador (para aportes/resgates)
 * @returns {object|null} movimento, ou null se não houver valor reconhecível
 */
function parseMessage(text, accounts = []) {
  const original = String(text || "").trim();
  if (!original) return null;

  // 1. Data primeiro — senão "dia 12" seria lido como valor.
  const { date, raw: dateRaw } = extractDate(original);
  let rest = dateRaw ? original.replace(dateRaw, " ") : original;

  // 2. Tipo
  const tipo = detectTipo(original);

  // 3. Valor
  const amount = extractAmount(rest);
  if (!amount) return null;
  rest = rest.replace(amount.raw, " ");

  // 4. Conta, quando o movimento é de conta
  let account = null;
  let accountHint = null;
  if (tipo === "aporte" || tipo === "resgate" || tipo === "rendimento") {
    accountHint = extractAccountHint(rest);
    account = matchAccount(accountHint, accounts);
  }

  // 5. Descrição e classificação
  let description = cleanDescription(rest);
  const haystack = norm(original);

  let category;
  if (tipo === "entrada") category = detectIn(haystack);
  else if (tipo === "saida") category = detectOut(haystack);
  else category = tipo; // aporte/resgate/rendimento não usam categoria de gasto

  if (!description) {
    description = {
      entrada: "Entrada",
      saida: "Saída",
      aporte: account ? `Aporte ${account.name}` : "Aporte",
      resgate: account ? `Resgate ${account.name}` : "Resgate",
      rendimento: account ? `Rendimento ${account.name}` : "Rendimento",
    }[tipo];
  }

  return {
    tipo,
    date,
    amount: Math.round(amount.value * 100) / 100,
    category,
    description,
    origin: detectOrigin(haystack, tipo),
    account_id: account ? account.id : null,
    accountHint,
    needsAccount: (tipo === "aporte" || tipo === "resgate" || tipo === "rendimento") && !account,
  };
}

module.exports = { parseMessage, parseNumber, extractAmount, extractDate, detectTipo, matchAccount };
