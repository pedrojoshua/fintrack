// Lançar vários itens numa mensagem só, e o menu de correção.
//
// Uma mensagem de várias linhas normalmente é uma lista ("aluguel 1200 /
// internet 100 / netflix 55"). Cada linha vira um lançamento. Com "mês que
// vem" na primeira linha, a lista vai para o planejamento em vez do mês
// corrente.

const db = require("../db");
const money = require("../money");
const { parseMessage } = require("../parser");
const { iconFor } = require("../categories");

const brl = (v) =>
  "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── Estado da conversa ───────────────────────────────
// Guardado nas configurações do usuário: sobrevive a reinícios do servidor,
// e cada usuário tem o seu. Expira sozinho para não corrigir algo de ontem.
const PENDENTE_TTL = 30 * 60 * 1000;

async function guardarPendente(userId, dados) {
  await db.query(
    `INSERT INTO settings (user_id, key, value) VALUES ($1, 'wa_pendente', $2)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [userId, JSON.stringify({ ...dados, em: Date.now() })]
  );
}

async function lerPendente(userId) {
  const r = await db.one("SELECT value FROM settings WHERE user_id = $1 AND key = 'wa_pendente'", [userId]);
  if (!r) return null;
  const v = r.value;
  if (!v || Date.now() - Number(v.em) > PENDENTE_TTL) return null;
  return v;
}

const limparPendente = (userId) =>
  db.query("DELETE FROM settings WHERE user_id = $1 AND key = 'wa_pendente'", [userId]);

// ── Cabeçalho que muda o destino da lista ────────────
// "todo mês" diz COMO lançar, não faz parte do nome — sem tirar, o item
// fica salvo como "Aluguel todo mês".
const RX_RECORRENTE = /\s*\b(todo m[êe]s|mensal|fixo|fixa|sempre|assinatura)\b/gi;
const ehRecorrente = (t) => /\b(todo m[êe]s|mensal|fixo|fixa|sempre|assinatura)\b/i.test(t);
const limpaNome = (n) => {
  const s = String(n || "").replace(RX_RECORRENTE, " ").replace(/\s+/g, " ").trim();
  return s.length >= 2 ? s.charAt(0).toUpperCase() + s.slice(1) : (n || "Lançamento");
};

const RX_PROXIMO = /^\s*(m[êe]s que vem|pr[óo]ximo m[êe]s|planejar|planeja|para o pr[óo]ximo|prev[ei]sto)\b[:\s]*/i;
const RX_ESTE = /^\s*(este m[êe]s|neste m[êe]s|deste m[êe]s|hoje)\b[:\s]*/i;

// Uma lista tem de ter pelo menos duas linhas que o parser entenda —
// senão é só uma frase que por acaso tem quebra de linha.
function separarLinhas(texto) {
  return String(texto || "")
    .split(/\r?\n|(?:\s+[;•]\s+)/)
    .map((l) => l.replace(/^\s*[-*•·]\s*/, "").trim())
    .filter((l) => l.length > 1);
}

function ehLista(texto) {
  const semCabecalho = texto.replace(RX_PROXIMO, "").replace(RX_ESTE, "");
  const linhas = separarLinhas(semCabecalho);
  if (linhas.length < 2) return false;
  const entendidas = linhas.filter((l) => parseMessage(l, []) !== null).length;
  // Metade já basta: numa lista real costuma haver um título ou um total.
  return entendidas >= 2 && entendidas >= Math.ceil(linhas.length / 2);
}

// ── Lote nos lançamentos do mês ──────────────────────
async function lancarLote(userId, texto, source) {
  const contas = await money.getAccounts(userId);
  const linhas = separarLinhas(texto.replace(RX_ESTE, ""));

  const feitos = [];
  const ignorados = [];

  for (const linha of linhas) {
    const p = parseMessage(linha, contas);
    if (!p || p.needsAccount) { ignorados.push(linha); continue; }

    const row = await db.one(
      `INSERT INTO transactions (user_id, date, tipo, amount, category, description, origin, source, account_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [userId, p.date, p.tipo, p.amount, p.category, p.description, p.origin, source, p.account_id]
    );
    feitos.push(row);
  }

  if (!feitos.length) {
    return "❓ Não consegui ler nenhuma linha.\n\nUma por linha, assim:\n`aluguel 1200`\n`internet 99,90`\n`mercado 350`";
  }

  const entradas = feitos.filter((r) => r.tipo === "entrada").reduce((s, r) => s + Number(r.amount), 0);
  const saidas = feitos.filter((r) => r.tipo === "saida").reduce((s, r) => s + Number(r.amount), 0);

  let txt = `✅ *${feitos.length} ${feitos.length === 1 ? "lançamento" : "lançamentos"}*\n\n`;
  txt += feitos.map((r) => {
    const sinal = r.tipo === "entrada" ? "+" : "−";
    return `${iconFor(r.category)} ${sinal} ${brl(r.amount)} — ${r.description}`;
  }).join("\n");

  if (entradas) txt += `\n\n↓ Entradas: *${brl(entradas)}*`;
  if (saidas) txt += `\n↑ Saídas: *${brl(saidas)}*`;

  if (ignorados.length) {
    txt += `\n\n⚠️ Não entendi ${ignorados.length} ${ignorados.length === 1 ? "linha" : "linhas"}:\n`;
    txt += ignorados.slice(0, 4).map((l) => `_${l.slice(0, 42)}_`).join("\n");
  }

  const now = new Date();
  const s = await money.getSummary(userId, now.getMonth() + 1, now.getFullYear());
  txt += `\n\n💵 Sobra este mês: *${brl(s.saldo_livre)}*`;
  txt += `\n\n_Errou algum? /desfazer apaga o último._`;
  return txt;
}

// ── Lote no planejamento do mês seguinte ─────────────
async function planejarLote(userId, texto) {
  const linhas = separarLinhas(texto.replace(RX_PROXIMO, ""));

  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  const mes = d.getMonth() + 1, ano = d.getFullYear();
  const ref = `${ano}-${String(mes).padStart(2, "0")}-01`;

  const feitos = [];
  const ignorados = [];

  for (const linha of linhas) {
    const p = parseMessage(linha, []);
    if (!p || (p.tipo !== "entrada" && p.tipo !== "saida")) { ignorados.push(linha); continue; }

    // Conta que se repete todo mês entra como fixa; o resto fica só neste mês.
    const fixo = ehRecorrente(linha);

    const row = await db.one(
      fixo
        ? `INSERT INTO planned (user_id, tipo, modo, name, amount, category, due_day)
           VALUES ($1,$2,'fixo',$3,$4,$5,$6) RETURNING *`
        : `INSERT INTO planned (user_id, tipo, modo, name, amount, category, ref_month)
           VALUES ($1,$2,'avulso',$3,$4,$5,$6::date) RETURNING *`,
      [userId, p.tipo, limpaNome(p.description), p.amount, p.category, fixo ? 5 : ref]
    );
    feitos.push({ ...row, fixo });
  }

  if (!feitos.length) {
    return "❓ Não consegui ler nenhuma linha.\n\nAssim:\n`mês que vem:`\n`aluguel 1200 todo mês`\n`ipva 850`\n`presente 300`";
  }

  const nomeMes = new Date(ano, mes - 1, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const p = await money.getPlanned(userId, mes, ano);

  let txt = `📅 *Planejado para ${nomeMes}*\n\n`;
  txt += feitos.map((r) => {
    const sinal = r.tipo === "entrada" ? "+" : "−";
    return `${iconFor(r.category)} ${sinal} ${brl(r.amount)} — ${r.name}${r.fixo ? " _(todo mês)_" : ""}`;
  }).join("\n");

  txt += `\n\n━━━━━━━━━━━━━\n`;
  txt += `↓ Entra: *${brl(p.total_previsto_entradas)}*\n`;
  txt += `↑ Sai: *${brl(p.total_previsto_saidas)}*\n`;
  txt += `💵 Sobra prevista: *${brl(p.sobra_prevista)}*`;

  if (p.sobra_prevista < 0) {
    txt += `\n\n🚨 O mês não fecha. Falta ${brl(-p.sobra_prevista)}.`;
  }
  if (ignorados.length) {
    txt += `\n\n⚠️ Não entendi ${ignorados.length}:\n` + ignorados.slice(0, 4).map((l) => `_${l.slice(0, 42)}_`).join("\n");
  }
  return txt;
}

module.exports = {
  RX_PROXIMO, RX_ESTE, ehLista, separarLinhas, ehRecorrente, limpaNome,
  lancarLote, planejarLote,
  guardarPendente, lerPendente, limparPendente,
  brl,
};
