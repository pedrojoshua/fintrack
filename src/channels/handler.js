// Lógica compartilhada entre WhatsApp e Telegram: comandos + registro por texto livre.
// As respostas usam *negrito* ao estilo WhatsApp; o Telegram converte para HTML.

const db = require("../db");
const money = require("../money");
const ai = require("../ai");
const lote = require("./lote");
const { parseMessage } = require("../parser");
const { iconFor, OUT, IN } = require("../categories");

const brl = (v) =>
  "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dm = (iso) => {
  const [y, m, d] = String(iso).split("-");
  return `${d}/${m}/${y}`;
};

const AJUDA =
  "💰 *FinTrack*\n\n" +
  "*Sem digitar nada*\n" +
  "📷 Mande a foto do cupom ou o print da notificação do banco\n" +
  "↪️ Encaminhe a mensagem que o banco te enviou\n" +
  "🎤 Mande um áudio: \"gastei cinquenta no mercado\"\n\n" +
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
  "*Vários de uma vez* (um por linha)\n" +
  "```\nmercado 350\nuber 45\nfarmacia 89,90\n```\n" +
  "*Planejar o mês que vem*\n" +
  "```\nmês que vem:\naluguel 1200 todo mês\nipva 850\n```\n" +
  "*Saldo da conta*\n" +
  "• `saldo 1234,56` — informa quanto tem na conta\n" +
  "• `saldo` — mostra o saldo atual\n\n" +
  "*Se ele errar*\n" +
  "Depois de cada lançamento aparecem as opções: responda *1* para trocar entre entrada e saída, *2* para trocar a categoria.\n\n" +
  "*Comandos*\n" +
  "/resumo — o mês em números\n" +
  "/reserva — reserva de emergência\n" +
  "/investimentos — carteira\n" +
  "/contas — suas contas\n" +
  "/saldo — saldo em conta\n" +
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
    `📈 Patrimônio: *${brl(s.patrimonio)}*`;

  if (s.entradas > 0) txt += `\n🎯 Taxa de poupança: *${s.taxa_poupanca}%*`;

  const top = s.by_category.slice(0, 5);
  if (top.length) {
    txt += `\n\n*Onde foi o dinheiro*\n`;
    txt += top.map((c) => `${iconFor(c.category)} ${c.category}: ${brl(c.total)}`).join("\n");
  }
  if (!s.count) txt += `\n\n_Ainda sem lançamentos este mês._`;
  return txt;
}

async function cmdReserva(userId) {
  const r = await money.getReserve(userId);
  if (!r.accounts.length) return "Você ainda não tem conta de reserva. Crie uma no painel *Reserva* do app.";

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
  else if (r.monthly_pace <= 0) txt += `\n\n⚠️ Você não está aportando — a meta não avança.`;
  return txt;
}

async function cmdInvestimentos(userId) {
  const inv = await money.getInvestments(userId);
  if (!inv.accounts.length && !inv.goals.length) {
    return "Você ainda não tem investimentos. Crie uma conta no painel *Investimentos* do app.";
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
  if (!accounts.length) return "Você ainda não tem contas criadas.";
  const emoji = { reserva: "🛟", investimento: "📈", meta: "🎯" };
  return (
    `🗂 *Suas contas*\n\n` +
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
  return `🗑 Excluído: *${brl(last.amount)}* — ${last.description} (${dm(last.date)})`;
}

// ── Registro de lançamento ─────────────────────────────
async function registrar(userId, text, source) {
  const accounts = await money.getAccounts(userId);

  // Notificação de banco encaminhada: o texto delas é feito para humanos, não
  // para regex ("Compra aprovada em UBER *TRIP BR"). A IA lê melhor.
  if (ai.ENABLED && ai.pareceNotificacaoBancaria(text)) {
    return registrarExtraido(userId, await ai.analisarTexto(text), source);
  }

  const parsed = parseMessage(text, accounts);

  // O parser de regras não entendeu — última tentativa com a IA.
  if (!parsed) {
    if (ai.ENABLED) {
      const dados = await ai.analisarTexto(text);
      if (!dados.erro && dados.encontrou) return registrarExtraido(userId, dados, source);
    }
    return (
      "❓ Não encontrei um valor nessa mensagem.\n\n" +
      "Tente assim: `50 mercado` ou `recebi 300 pix`.\n" +
      "Também pode mandar a foto do comprovante, o print da notificação do banco, ou um áudio.\n" +
      "Escreva /ajuda para ver os exemplos."
    );
  }

  // Lançamento de conta sem conta identificada: mostra as opções em vez de adivinhar.
  if (parsed.needsAccount) {
    const candidatas = accounts.filter((a) =>
      parsed.tipo === "rendimento" ? a.kind !== "reserva" : true
    );
    if (!candidatas.length) {
      return "Você precisa criar uma conta primeiro, no painel *Reserva* ou *Investimentos* do app.";
    }
    return (
      `🤔 Para qual conta?\n\n` +
      candidatas.map((a) => `• ${a.name}`).join("\n") +
      `\n\nRepita indicando a conta, por exemplo:\n\`${text} na ${candidatas[0].name.toLowerCase()}\``
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

  let txt = `${emoji} *Registrado*\n${sinal} ${brl(row.amount)} — ${row.description}\n`;

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

  // Deixa o caminho da correção à vista. Sem isto, quem viu o bot classificar
  // errado não sabe o que fazer além de abrir o app.
  if (!row.account_id) {
    const oposto = row.tipo === "entrada" ? "saída" : "entrada";
    txt += `\n\n_Errado? Responda *1* se era ${oposto}, *2* para trocar a categoria._`;
    await lote.guardarPendente(userId, { txId: row.id, etapa: "correcao", tipo: row.tipo });
  }

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
  falhou: "🤖 Falhou a leitura. Tente de novo, ou escreva o valor à mão.",
  sem_resposta: "🤖 Não entendi o que está na imagem.",
  vazio: "🎤 Não consegui ouvir nada. Grave de novo mais perto do microfone.",
};

async function registrarExtraido(userId, dados, source) {
  if (dados.erro) return ERROS_IA[dados.erro] || ERROS_IA.falhou;

  if (!dados.encontrou || !(dados.valor > 0)) {
    return "🤔 Não encontrei nenhum valor aí.\n\nSe for um comprovante, tente uma foto mais nítida. Ou escreva à mão: `50 mercado`";
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
    txt += `\n\n⚠️ Não tenho certeza do que li. Confira no app.`;
  }
  if (dados.observacao) txt += `\n_${dados.observacao}_`;
  if (dados.parcelas > 1) {
    txt += `\n\n💳 Parece parcelado em ${dados.parcelas}x. Lancei o valor total — se quiseres acompanhar parcela a parcela, registra em *Planos* no app.`;
  }
  return txt;
}

/** Foto ou print enviado no WhatsApp. */
async function handleImage(userId, base64, mediaType, source = "whatsapp") {
  return registrarExtraido(userId, await ai.analisarImagem(base64, mediaType), source);
}

/** Nota de voz: transcreve e trata como se tivesse sido escrita. */
async function handleAudio(userId, base64, mimetype, source = "whatsapp") {
  const r = await ai.transcreverAudio(base64, mimetype);
  if (r.erro) return ERROS_IA[r.erro] || ERROS_IA.falhou;

  const resposta = await handleMessage(userId, r.texto, source);
  return `🎤 _"${r.texto}"_\n\n${resposta}`;
}

// ── Correção por número ──────────────────────────────
// O usuário acabou de ver o lançamento e responde só um número. Sem estado
// guardado isto seria impossível — daí o "pendente".
async function tratarCorrecao(userId, escolha, pend) {
  const tx = await db.one("SELECT * FROM transactions WHERE id = $1 AND user_id = $2", [pend.txId, userId]);
  if (!tx) { await lote.limparPendente(userId); return null; }

  if (pend.etapa === "correcao") {
    if (escolha === 1) {
      const novo = tx.tipo === "entrada" ? "saida" : "entrada";
      // A categoria pertence ao tipo: as de gasto não servem para entrada.
      const lista = novo === "entrada" ? IN : OUT;
      const cat = lista.find((c) => c.id === tx.category) ? tx.category : "outros";
      const row = await db.one(
        "UPDATE transactions SET tipo = $1, category = $2 WHERE id = $3 RETURNING *",
        [novo, cat, tx.id]
      );
      await lote.limparPendente(userId);
      const sinal = novo === "entrada" ? "+" : "−";
      return `✅ Corrigido para *${novo === "entrada" ? "entrada" : "saída"}*\n${sinal} ${brl(row.amount)} — ${row.description}`;
    }

    if (escolha === 2) {
      const lista = tx.tipo === "entrada" ? IN : OUT;
      await lote.guardarPendente(userId, { txId: tx.id, etapa: "categoria", opcoes: lista.map((c) => c.id) });
      return (
        `📁 Qual categoria?\n\n` +
        lista.map((c, i) => `*${i + 1}* ${c.icon} ${c.label}`).join("\n") +
        `\n\n_Responda com o número._`
      );
    }
    return null;
  }

  if (pend.etapa === "categoria") {
    const cat = pend.opcoes[escolha - 1];
    if (!cat) return `Número fora da lista. Responda de 1 a ${pend.opcoes.length}.`;
    const row = await db.one("UPDATE transactions SET category = $1 WHERE id = $2 RETURNING *", [cat, tx.id]);
    await lote.limparPendente(userId);
    return `✅ Categoria alterada para ${iconFor(cat)} *${cat}*\n${brl(row.amount)} — ${row.description}`;
  }
  return null;
}

// ── Saldo da conta ───────────────────────────────────
async function cmdSaldo(userId, texto) {
  const contas = await money.getAccounts(userId);
  const correntes = contas.filter((a) => a.kind === "corrente");

  // Reusa o extrator do parser: escrever outro regex aqui já causou um bug
  // em que "2500,50" virava 250 (faltava exigir o separador de milhar).
  const { extractAmount } = require("../parser");
  const m = extractAmount(texto.replace(/^\s*\/?saldo\b/i, ""));

  // Sem valor é pergunta, não comando.
  if (!m) {
    if (!correntes.length) {
      return "Você ainda não tem conta corrente.\n\nCrie em *Investir → + Conta* no app, ou diga o saldo aqui:\n`saldo 1234,56`";
    }
    return (
      `🏦 *Saldo em conta*\n\n` +
      correntes.map((a) => `• ${a.name}: *${brl(a.balance)}*`).join("\n") +
      `\n\n_Para atualizar: \`saldo 1234,56\`_`
    );
  }

  const valor = m.value;
  if (!Number.isFinite(valor)) return "Não entendi o valor. Exemplo: `saldo 1234,56`";

  // Sem conta corrente ainda, cria uma na hora — é o que a pessoa quer.
  let conta = correntes[0];
  if (!conta) {
    conta = await db.one(
      `INSERT INTO accounts (user_id, name, kind, institution) VALUES ($1,'Conta corrente','corrente','') RETURNING *`,
      [userId]
    );
    conta.balance = 0;
  }

  // Ajusta o saldo de partida em vez de criar um lançamento falso, para o
  // mês não ganhar uma entrada que nunca existiu.
  const mov = await db.one(
    `SELECT COALESCE(SUM(CASE tipo WHEN 'aporte' THEN amount WHEN 'rendimento' THEN amount
                                  WHEN 'resgate' THEN -amount ELSE 0 END), 0) AS total
       FROM transactions WHERE account_id = $1`,
    [conta.id]
  );
  await db.query("UPDATE accounts SET opening_balance = $1 WHERE id = $2",
    [Math.round((valor - Number(mov.total)) * 100) / 100, conta.id]);

  const now = new Date();
  const s = await money.getSummary(userId, now.getMonth() + 1, now.getFullYear());
  return (
    `🏦 *${conta.name}*: ${brl(valor)}\n\n` +
    `📈 Património total: *${brl(s.patrimonio)}*\n` +
    `_(conta + reserva + investimentos)_`
  );
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

  // Resposta de um número só: é escolha de menu, não lançamento.
  const soNumero = /^\s*(\d{1,2})\s*$/.exec(t);
  if (soNumero) {
    const pend = await lote.lerPendente(userId);
    if (pend) {
      const r = await tratarCorrecao(userId, Number(soNumero[1]), pend);
      if (r) return r;
    }
  }

  const cmd = t.toLowerCase().split(/\s+/)[0];
  if (cmd === "saldo" || cmd === "/saldo") return cmdSaldo(userId, t);

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
    case "/excluir":
      return cmdDesfazer(userId);
  }

  // "Mês que vem ..." vai para o planejamento, não para o mês corrente.
  if (lote.RX_PROXIMO.test(t)) {
    return lote.ehLista(t) ? lote.planejarLote(userId, t) : planejarUm(userId, t);
  }

  // Várias linhas que o parser entende → lote de uma vez só.
  if (lote.ehLista(t)) return lote.lancarLote(userId, t, source);

  // Não é comando → tentar interpretar como lançamento.
  return registrar(userId, t, source);
}

// Um único item para o mês que vem.
async function planejarUm(userId, texto) {
  const p = parseMessage(texto.replace(lote.RX_PROXIMO, ""), []);
  if (!p || (p.tipo !== "entrada" && p.tipo !== "saida")) {
    return "❓ Não encontrei o valor.\n\nExemplo: `mês que vem ipva 850`";
  }

  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  const mes = d.getMonth() + 1, ano = d.getFullYear();
  const fixo = /\b(todo m[êe]s|mensal|fixo|fixa|sempre|assinatura)\b/i.test(texto);

  await db.one(
    fixo
      ? `INSERT INTO planned (user_id,tipo,modo,name,amount,category,due_day) VALUES ($1,$2,'fixo',$3,$4,$5,5) RETURNING id`
      : `INSERT INTO planned (user_id,tipo,modo,name,amount,category,ref_month) VALUES ($1,$2,'avulso',$3,$4,$5,$6::date) RETURNING id`,
    fixo
      ? [userId, p.tipo, lote.limpaNome(p.description), p.amount, p.category]
      : [userId, p.tipo, lote.limpaNome(p.description), p.amount, p.category, `${ano}-${String(mes).padStart(2, "0")}-01`]
  );

  const pl = await money.getPlanned(userId, mes, ano);
  const nomeMes = new Date(ano, mes - 1, 1).toLocaleDateString("pt-BR", { month: "long" });
  return (
    `📅 *Planejado para ${nomeMes}*\n` +
    `${iconFor(p.category)} ${p.tipo === "entrada" ? "+" : "−"} ${brl(p.amount)} — ${p.description}` +
    (fixo ? " _(todo mês)_" : "") +
    `\n\n💵 Sobra prevista: *${brl(pl.sobra_prevista)}*`
  );
}

module.exports = { handleMessage, handleImage, handleAudio, AJUDA, brl };
