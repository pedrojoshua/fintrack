// Lógica partilhada entre WhatsApp e Telegram: comandos + registo por texto livre.
// As respostas usam *negrito* ao estilo WhatsApp; o Telegram converte para HTML.

const db = require("../db");
const money = require("../money");
const ai = require("../ai");
const { parseMessage } = require("../parser");
const { iconFor } = require("../categories");

const brl = (v) =>
  "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dm = (iso) => {
  const [y, m, d] = String(iso).split("-");
  return `${d}/${m}/${y}`;
};

const AJUDA =
  "💰 *FinTrack*\n\n" +
  "*Sem digitar nada*\n" +
  "📷 Manda a foto do cupom ou o print da notificação do banco\n" +
  "↪️ Encaminha a mensagem que o banco te enviou\n" +
  "🎤 Manda um áudio: \"gastei cinquenta no mercado\"\n\n" +
  "*Escrevendo* (sem formato fixo)\n" +
  "• `50 mercado`\n" +
  "• `paguei 89,90 netflix`\n" +
  "• `ontem 45 uber`\n" +
  "• `12/03 350 ipva`\n\n" +
  "*Entradas*\n" +
  "• `recebi 300 pix do pedro`\n" +
  "• `entrada 4000 salario`\n\n" +
  "*Reserva e investimentos*\n" +
  "• `guardei 500 na reserva`\n" +
  "• `investi 1000 no tesouro selic`\n" +
  "• `resgatei 200 da reserva`\n" +
  "• `rendeu 15,40 no tesouro selic`\n\n" +
  "*Comandos*\n" +
  "/resumo — o mês em números\n" +
  "/reserva — reserva de emergência\n" +
  "/investimentos — carteira\n" +
  "/contas — as tuas contas\n" +
  "/desfazer — apaga o último lançamento";

// ── Comandos ─────────────────────────────────────────
async function cmdResumo(userId) {
  const now = new Date();
  const s = await money.getSummary(userId, now.getMonth() + 1, now.getFullYear());
  const mes = now.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  let txt =
    `📊 *${mes}*\n\n` +
    `↓ Entradas: *${brl(s.entradas)}*\n` +
    `↑ Saídas: *${brl(s.saidas)}*\n` +
    `🐖 Guardado: *${brl(s.aportes - s.resgates)}*\n` +
    `━━━━━━━━━━━━━\n` +
    `💵 Sobra livre: *${brl(s.saldo_livre)}*\n` +
    `📈 Património: *${brl(s.patrimonio)}*`;

  if (s.entradas > 0) txt += `\n🎯 Taxa de poupança: *${s.taxa_poupanca}%*`;

  const top = s.by_category.slice(0, 5);
  if (top.length) {
    txt += `\n\n*Onde foi o dinheiro*\n`;
    txt += top.map((c) => `${iconFor(c.category)} ${c.category}: ${brl(c.total)}`).join("\n");
  }
  if (!s.count) txt += `\n\n_Ainda sem movimentos este mês._`;
  return txt;
}

async function cmdReserva(userId) {
  const r = await money.getReserve(userId);
  if (!r.accounts.length) return "Ainda não tens conta de reserva. Cria uma no painel *Reserva* da app.";

  const barras = Math.round(r.goal_pct / 10);
  const barra = "█".repeat(barras) + "░".repeat(10 - barras);

  let txt =
    `🛟 *Reserva de Emergência*\n\n` +
    `${barra} ${r.goal_pct}%\n\n` +
    `Guardado: *${brl(r.balance)}*\n` +
    `Meta (${r.target_months} meses): *${brl(r.target)}*\n` +
    `Falta: *${brl(r.missing)}*\n\n` +
    `Cobre *${r.coverage_months}* ${r.coverage_months === 1 ? "mês" : "meses"} de despesa\n` +
    `Despesa média: ${brl(r.avg_expense)}`;

  if (r.months_to_target === 0) txt += `\n\n✅ *Meta atingida.*`;
  else if (r.months_to_target) txt += `\n\n⏳ No ritmo atual (${brl(r.monthly_pace)}/mês): *${r.months_to_target} meses*`;
  else if (r.monthly_pace <= 0) txt += `\n\n⚠️ Não estás a aportar — a meta não avança.`;
  return txt;
}

async function cmdInvestimentos(userId) {
  const inv = await money.getInvestments(userId);
  if (!inv.accounts.length && !inv.goals.length) {
    return "Ainda não tens investimentos. Cria uma conta no painel *Investimentos* da app.";
  }

  let txt = `📈 *Carteira*\n\nTotal: *${brl(inv.total_balance)}*\n`;
  if (inv.total_yield !== 0) txt += `Rendimento: *${brl(inv.total_yield)}* (${inv.yield_pct}%)\n`;

  if (inv.accounts.length) {
    txt += `\n*Contas*\n`;
    txt += inv.accounts
      .map((a) => `• ${a.name}: *${brl(a.balance)}*` + (a.yield_total ? ` _(+${brl(a.yield_total)})_` : ""))
      .join("\n");
  }
  if (inv.goals.length) {
    txt += `\n\n*Metas*\n`;
    txt += inv.goals
      .map((a) => `🎯 ${a.name}: *${brl(a.balance)}*` + (a.goal > 0 ? ` de ${brl(a.goal)} (${a.goal_pct}%)` : ""))
      .join("\n");
  }
  return txt;
}

async function cmdContas(userId) {
  const accounts = await money.getAccounts(userId);
  if (!accounts.length) return "Ainda não tens contas criadas.";
  const emoji = { reserva: "🛟", investimento: "📈", meta: "🎯" };
  return (
    `🗂 *As tuas contas*\n\n` +
    accounts.map((a) => `${emoji[a.kind]} *${a.name}* — ${brl(a.balance)}`).join("\n") +
    `\n\n_Para lançar: "guardei 200 na ${accounts[0].name.toLowerCase()}"_`
  );
}

async function cmdDesfazer(userId) {
  const last = await db.one(
    `DELETE FROM transactions WHERE id = (
       SELECT id FROM transactions WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1
     ) RETURNING *`,
    [userId]
  );
  if (!last) return "Não há nada para desfazer.";
  return `🗑 Apagado: *${brl(last.amount)}* — ${last.description} (${dm(last.date)})`;
}

// ── Registo de movimento ─────────────────────────────
async function registar(userId, text, source) {
  const accounts = await money.getAccounts(userId);

  // Notificação de banco encaminhada: o texto delas é feito para humanos, não
  // para regex ("Compra aprovada em UBER *TRIP BR"). A IA lê melhor.
  if (ai.ENABLED && ai.pareceNotificacaoBancaria(text)) {
    return registarExtraido(userId, await ai.analisarTexto(text), source);
  }

  const parsed = parseMessage(text, accounts);

  // O parser de regras não entendeu — última tentativa com a IA.
  if (!parsed) {
    if (ai.ENABLED) {
      const dados = await ai.analisarTexto(text);
      if (!dados.erro && dados.encontrou) return registarExtraido(userId, dados, source);
    }
    return (
      "❓ Não encontrei um valor nessa mensagem.\n\n" +
      "Tenta assim: `50 mercado` ou `recebi 300 pix`.\n" +
      "Também podes mandar a foto do comprovante, o print da notificação do banco, ou um áudio.\n" +
      "Escreve /ajuda para ver os exemplos."
    );
  }

  // Movimento de conta sem conta identificada: mostra as opções em vez de adivinhar.
  if (parsed.needsAccount) {
    const candidatas = accounts.filter((a) =>
      parsed.tipo === "rendimento" ? a.kind !== "reserva" : true
    );
    if (!candidatas.length) {
      return "Precisas de criar uma conta primeiro, no painel *Reserva* ou *Investimentos* da app.";
    }
    return (
      `🤔 Para qual conta?\n\n` +
      candidatas.map((a) => `• ${a.name}`).join("\n") +
      `\n\nRepete indicando a conta, por exemplo:\n\`${text} na ${candidatas[0].name.toLowerCase()}\``
    );
  }

  const row = await db.one(
    `INSERT INTO transactions (user_id, date, tipo, amount, category, description, origin, source, account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, parsed.date, parsed.tipo, parsed.amount, parsed.category,
     parsed.description, parsed.origin, source, parsed.account_id]
  );

  return await confirmacao(userId, row);
}

// Confirmação com contexto útil: quanto sobra, quanto falta para a meta.
async function confirmacao(userId, row) {
  const sinal = { entrada: "+", saida: "−", aporte: "→", resgate: "←", rendimento: "+" }[row.tipo];
  const emoji = { aporte: "🐖", resgate: "↩️", rendimento: "📈" }[row.tipo] || iconFor(row.category);

  let txt = `${emoji} *Registado*\n${sinal} ${brl(row.amount)} — ${row.description}\n`;

  if (row.account_id) {
    const acc = (await money.getAccounts(userId)).find((a) => a.id === row.account_id);
    if (acc) {
      txt += `🏦 ${acc.name}: *${brl(acc.balance)}*`;
      if (acc.goal > 0) txt += ` _(${acc.goal_pct}% da meta)_`;
      txt += `\n`;
    }
  } else {
    txt += `📁 ${row.category}\n`;
  }
  txt += `📅 ${dm(row.date)}`;

  // Depois de uma despesa, mostrar o que ainda sobra no mês evita surpresas.
  if (row.tipo === "saida") {
    const now = new Date();
    const [y, m] = String(row.date).split("-").map(Number);
    if (m === now.getMonth() + 1 && y === now.getFullYear()) {
      const s = await money.getSummary(userId, m, y);
      txt += `\n\n💵 Sobra este mês: *${brl(s.saldo_livre)}*`;

      const cat = s.by_category.find((c) => c.category === row.category);
      if (cat && cat.budget) {
        const restante = cat.budget - cat.total;
        txt +=
          restante >= 0
            ? `\n🎯 ${row.category}: resta ${brl(restante)} do orçamento`
            : `\n🚨 ${row.category}: passaste ${brl(-restante)} do orçamento`;
      }
    }
  }
  return txt;
}

// ── Lançamento vindo da IA (imagem ou notificação de banco) ──
const ERROS_IA = {
  sem_ia: "🤖 A leitura automática não está configurada no servidor.",
  sem_transcricao: "🎤 A transcrição de áudio não está configurada no servidor.",
  recusado: "🤖 Não consegui processar essa imagem.",
  falhou: "🤖 Falhou a leitura. Tenta de novo, ou escreve o valor à mão.",
  sem_resposta: "🤖 Não percebi o que está na imagem.",
  vazio: "🎤 Não consegui ouvir nada. Grava de novo mais perto do microfone.",
};

async function registarExtraido(userId, dados, source) {
  if (dados.erro) return ERROS_IA[dados.erro] || ERROS_IA.falhou;

  if (!dados.encontrou || !(dados.valor > 0)) {
    return "🤔 Não encontrei nenhum valor aí.\n\nSe for um comprovante, tenta uma foto mais nítida. Ou escreve à mão: `50 mercado`";
  }

  const tipo = dados.tipo === "entrada" ? "entrada" : "saida";
  const data = /^\d{4}-\d{2}-\d{2}$/.test(dados.data || "") ? dados.data : new Date().toISOString().slice(0, 10);

  const row = await db.one(
    `INSERT INTO transactions (user_id, date, tipo, amount, category, description, origin, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [userId, data, tipo, Math.round(dados.valor * 100) / 100,
     dados.categoria || "outros", dados.descricao || "Lançamento", dados.origem || "outro", source]
  );

  let txt = await confirmacao(userId, row);

  // Leitura duvidosa: avisa em vez de deixar passar em silêncio.
  if (dados.confianca === "baixa") {
    txt += `\n\n⚠️ Não tenho certeza do que li. Confere na app.`;
  }
  if (dados.observacao) txt += `\n_${dados.observacao}_`;
  if (dados.parcelas > 1) {
    txt += `\n\n💳 Parece parcelado em ${dados.parcelas}x. Lancei o valor total — se quiseres acompanhar parcela a parcela, regista em *Planos* na app.`;
  }
  return txt;
}

/** Foto ou print enviado no WhatsApp. */
async function handleImage(userId, base64, mediaType, source = "whatsapp") {
  return registarExtraido(userId, await ai.analisarImagem(base64, mediaType), source);
}

/** Nota de voz: transcreve e trata como se tivesse sido escrita. */
async function handleAudio(userId, base64, mimetype, source = "whatsapp") {
  const r = await ai.transcreverAudio(base64, mimetype);
  if (r.erro) return ERROS_IA[r.erro] || ERROS_IA.falhou;

  const resposta = await handleMessage(userId, r.texto, source);
  return `🎤 _"${r.texto}"_\n\n${resposta}`;
}

/**
 * Trata uma mensagem recebida de qualquer canal.
 * @param {number} userId
 * @param {string} text
 * @param {string} source "whatsapp" | "telegram"
 * @returns {Promise<string>} resposta a enviar
 */
async function handleMessage(userId, text, source = "whatsapp") {
  const t = String(text || "").trim();
  if (!t) return null;

  const cmd = t.toLowerCase().split(/\s+/)[0];
  switch (cmd) {
    case "/start":
    case "/ajuda":
    case "/help":
    case "ajuda":
      return AJUDA;
    case "/resumo":
    case "resumo":
      return cmdResumo(userId);
    case "/reserva":
    case "reserva":
      return cmdReserva(userId);
    case "/investimentos":
    case "/carteira":
      return cmdInvestimentos(userId);
    case "/contas":
      return cmdContas(userId);
    case "/desfazer":
    case "/apagar":
      return cmdDesfazer(userId);
  }

  // Não é comando → tentar interpretar como movimento.
  return registar(userId, t, source);
}

module.exports = { handleMessage, handleImage, handleAudio, AJUDA, brl };
