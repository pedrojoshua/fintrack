// Regras de negócio: saldos de contas, resumo mensal, reserva de emergência
// e carteira de investimentos.
//
// Modelo de dinheiro:
//   entrada    → dinheiro entra no mês
//   saida      → despesa do mês
//   aporte     → sai do mês e entra numa conta (não é despesa, é poupança)
//   resgate    → sai de uma conta e volta ao mês
//   rendimento → cresce dentro da conta, sem passar pelo mês
//
//   saldo livre do mês = entradas − saídas − aportes + resgates
//   patrimônio         = soma dos saldos das contas

const db = require("./db");

const DEFAULT_SETTINGS = {
  monthly_income: 0,      // rendimento mensal esperado
  reserve_months: 6,      // meta da reserva, em meses de despesa
  baseline_months: 3,     // janela para calcular a despesa média
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Configurações ───────────────────────────────────────
async function getSettings(userId) {
  const rows = await db.query("SELECT key, value FROM settings WHERE user_id = $1", [userId]);
  const cfg = { ...DEFAULT_SETTINGS };
  for (const r of rows) cfg[r.key] = r.value;
  return cfg;
}

async function saveSettings(userId, patch) {
  const allowed = Object.keys(DEFAULT_SETTINGS);
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.includes(key)) continue;
    await db.query(
      `INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [userId, key, JSON.stringify(value)]
    );
  }
  return getSettings(userId);
}

// ── Contas com saldo derivado ────────────────────────
// O saldo nunca é guardado: é sempre recalculado a partir dos lançamentos,
// por isso não fica dessincronizado.
const ACCOUNTS_SQL = `
  SELECT
    a.id, a.name, a.kind, a.institution, a.goal, a.expected_yield,
    a.opening_balance, a.target_date, a.archived, a.created_at,
    a.opening_balance
      + COALESCE(SUM(CASE t.tipo WHEN 'aporte'     THEN  t.amount
                                 WHEN 'rendimento' THEN  t.amount
                                 WHEN 'resgate'    THEN -t.amount
                                 ELSE 0 END), 0)                       AS balance,
    COALESCE(SUM(CASE WHEN t.tipo = 'aporte'     THEN t.amount END), 0) AS invested,
    COALESCE(SUM(CASE WHEN t.tipo = 'resgate'    THEN t.amount END), 0) AS withdrawn,
    COALESCE(SUM(CASE WHEN t.tipo = 'rendimento' THEN t.amount END), 0) AS yield_total,
    MAX(t.date) FILTER (WHERE t.tipo = 'aporte')                        AS last_deposit
  FROM accounts a
  LEFT JOIN transactions t ON t.account_id = a.id
  WHERE a.user_id = $1
  GROUP BY a.id
  ORDER BY a.kind, a.created_at
`;

async function getAccounts(userId, { includeArchived = false } = {}) {
  const rows = await db.query(ACCOUNTS_SQL, [userId]);
  const list = includeArchived ? rows : rows.filter((a) => !a.archived);
  return list.map((a) => {
    const base = a.invested - a.withdrawn + a.opening_balance;
    return {
      ...a,
      balance: round2(a.balance),
      invested: round2(a.invested),
      withdrawn: round2(a.withdrawn),
      yield_total: round2(a.yield_total),
      // rentabilidade sobre o capital efetivamente colocado
      yield_pct: base > 0 ? round2((a.yield_total / base) * 100) : 0,
      goal_pct: a.goal > 0 ? round2(Math.min((a.balance / a.goal) * 100, 100)) : null,
    };
  });
}

// ── Despesa média mensal ─────────────────────────────
// Média das saídas dos últimos N meses completos com lançamento.
// Serve de base para dimensionar a reserva de emergência.
async function averageMonthlyExpense(userId, months) {
  const rows = await db.query(
    `SELECT to_char(date, 'YYYY-MM') AS ym, SUM(amount) AS total
       FROM transactions
      WHERE user_id = $1 AND tipo = 'saida'
        AND date >= date_trunc('month', CURRENT_DATE) - ($2::int * INTERVAL '1 month')
        AND date <  date_trunc('month', CURRENT_DATE)
      GROUP BY ym ORDER BY ym DESC`,
    [userId, months]
  );
  if (!rows.length) {
    // Sem histórico fechado ainda: usa o mês corrente como aproximação.
    const cur = await db.one(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
        WHERE user_id = $1 AND tipo = 'saida' AND date >= date_trunc('month', CURRENT_DATE)`,
      [userId]
    );
    return { average: round2(cur.total), months_used: cur.total > 0 ? 1 : 0, partial: true };
  }
  const avg = rows.reduce((s, r) => s + Number(r.total), 0) / rows.length;
  return { average: round2(avg), months_used: rows.length, partial: false };
}

// ── Reserva de emergência ────────────────────────────
async function getReserve(userId) {
  const cfg = await getSettings(userId);
  const accounts = (await getAccounts(userId)).filter((a) => a.kind === "reserva");
  const balance = round2(accounts.reduce((s, a) => s + a.balance, 0));

  const { average, months_used, partial } = await averageMonthlyExpense(userId, cfg.baseline_months);
  const target = round2(average * cfg.reserve_months);
  const coverage = average > 0 ? round2(balance / average) : 0;

  // Ritmo dos últimos 3 meses, para estimar quando a meta é atingida.
  const pace = await db.one(
    `SELECT COALESCE(SUM(CASE t.tipo WHEN 'aporte' THEN t.amount WHEN 'resgate' THEN -t.amount ELSE 0 END), 0) AS net
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1 AND a.kind = 'reserva'
        AND t.date >= date_trunc('month', CURRENT_DATE) - INTERVAL '3 months'`,
    [userId]
  );
  const monthlyPace = round2(Number(pace.net) / 3);
  const missing = round2(Math.max(target - balance, 0));

  return {
    balance,
    target,
    goal_pct: target > 0 ? round2(Math.min((balance / target) * 100, 100)) : 0,
    missing,
    coverage_months: coverage,
    target_months: cfg.reserve_months,
    avg_expense: average,
    baseline_months_used: months_used,
    baseline_partial: partial,
    monthly_pace: monthlyPace,
    // meses até à meta ao ritmo atual (null se não está a poupar)
    months_to_target: monthlyPace > 0 && missing > 0 ? Math.ceil(missing / monthlyPace) : (missing === 0 ? 0 : null),
    accounts,
  };
}

// ── Investimentos e metas ────────────────────────────
async function getInvestments(userId) {
  const all = await getAccounts(userId);
  const invest = all.filter((a) => a.kind === "investimento");
  const metas = all.filter((a) => a.kind === "meta");

  const sum = (list, f) => round2(list.reduce((s, a) => s + f(a), 0));
  const investedBase = sum(invest, (a) => a.invested - a.withdrawn + a.opening_balance);
  const yieldTotal = sum(invest, (a) => a.yield_total);

  return {
    accounts: invest,
    goals: metas,
    total_balance: sum(invest, (a) => a.balance),
    total_invested: sum(invest, (a) => a.invested),
    total_yield: yieldTotal,
    yield_pct: investedBase > 0 ? round2((yieldTotal / investedBase) * 100) : 0,
    goals_balance: sum(metas, (a) => a.balance),
  };
}

// ── Resumo mensal ────────────────────────────────────
async function getSummary(userId, month, year) {
  const cfg = await getSettings(userId);
  const from = `${year}-${String(month).padStart(2, "0")}-01`;

  const totals = await db.one(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE tipo = 'entrada'), 0) AS entradas,
       COALESCE(SUM(amount) FILTER (WHERE tipo = 'saida'),   0) AS saidas,
       COALESCE(SUM(amount) FILTER (WHERE tipo = 'aporte'),  0) AS aportes,
       COALESCE(SUM(amount) FILTER (WHERE tipo = 'resgate'), 0) AS resgates,
       COUNT(*) AS n
     FROM transactions
     WHERE user_id = $1 AND date >= $2::date AND date < ($2::date + INTERVAL '1 month')`,
    [userId, from]
  );

  const byCategory = await db.query(
    `SELECT category, SUM(amount) AS total, COUNT(*) AS n
       FROM transactions
      WHERE user_id = $1 AND tipo = 'saida'
        AND date >= $2::date AND date < ($2::date + INTERVAL '1 month')
      GROUP BY category ORDER BY total DESC`,
    [userId, from]
  );

  // Últimos 6 meses, para o gráfico de tendência.
  const trend = await db.query(
    `SELECT to_char(d, 'YYYY-MM') AS month,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tipo = 'entrada'), 0) AS entradas,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tipo = 'saida'),   0) AS saidas,
            COALESCE(SUM(t.amount) FILTER (WHERE t.tipo = 'aporte'),  0) AS aportes
       FROM generate_series(
              date_trunc('month', $2::date) - INTERVAL '5 months',
              date_trunc('month', $2::date), INTERVAL '1 month') AS d
       LEFT JOIN transactions t
              ON t.user_id = $1
             AND t.date >= d AND t.date < d + INTERVAL '1 month'
      GROUP BY d ORDER BY d`,
    [userId, from]
  );

  const entradas = round2(totals.entradas);
  const saidas = round2(totals.saidas);
  const aportes = round2(totals.aportes);
  const resgates = round2(totals.resgates);
  const livre = round2(entradas - saidas - aportes + resgates);

  const accounts = await getAccounts(userId);
  const patrimonio = round2(accounts.reduce((s, a) => s + a.balance, 0));
  // O que está na conta agora, separado do que está guardado.
  const correntes = accounts.filter((a) => a.kind === "corrente");
  const saldoCorrente = round2(correntes.reduce((s, a) => s + a.balance, 0));

  const budgets = await db.query("SELECT category, amount FROM budgets WHERE user_id = $1", [userId]);
  const budgetMap = Object.fromEntries(budgets.map((b) => [b.category, round2(b.amount)]));

  // O salário fixo declarado no planeamento é a referência de rendimento.
  // O campo manual das configurações fica como alternativa para quem não o usa.
  const rendaFixa = await fixedIncome(userId);
  const rendaPrevista = rendaFixa || round2(cfg.monthly_income);

  return {
    month, year,
    entradas, saidas, aportes, resgates,
    renda_fixa: rendaFixa,
    renda_prevista: rendaPrevista,
    saldo_corrente: saldoCorrente,
    tem_corrente: correntes.length > 0,
    saldo_livre: livre,
    // quanto do que entrou foi poupado
    taxa_poupanca: entradas > 0 ? round2(((aportes - resgates) / entradas) * 100) : 0,
    patrimonio,
    count: Number(totals.n),
    by_category: byCategory.map((c) => ({
      category: c.category,
      total: round2(c.total),
      count: Number(c.n),
      budget: budgetMap[c.category] ?? null,
      budget_pct: budgetMap[c.category] ? round2((c.total / budgetMap[c.category]) * 100) : null,
    })),
    trend: trend.map((t) => ({
      month: t.month,
      entradas: round2(t.entradas),
      saidas: round2(t.saidas),
      aportes: round2(t.aportes),
    })),
    settings: cfg,
  };
}

// ── Planeamento do mês ───────────────────────────────
// Junta o que se repete todos os meses (fixos) com o que só existe naquele
// mês (fatura do cartão e gastos pontuais previstos).
async function getPlanned(userId, month, year) {
  const ref = `${year}-${String(month).padStart(2, "0")}-01`;

  // Traz também os pausados: se desaparecessem da lista não haveria como
  // voltar a ligá-los. Só não entram nas somas.
  const rows = await db.query(
    `SELECT * FROM planned
      WHERE user_id = $1
        AND (modo = 'fixo' OR ref_month = $2::date)
      ORDER BY modo, tipo, active DESC, due_day NULLS LAST, name`,
    [userId, ref]
  );

  const norm = (r) => ({ ...r, amount: round2(r.amount) });
  const fixos = rows.filter((r) => r.modo === "fixo").map(norm);
  const cartao = rows.filter((r) => r.modo === "cartao").map(norm);
  const avulso = rows.filter((r) => r.modo === "avulso").map(norm);

  const sum = (list) => round2(list.filter((r) => r.active).reduce((s, r) => s + Number(r.amount), 0));
  const receitasFixas = sum(fixos.filter((r) => r.tipo === "entrada"));
  const despesasFixas = sum(fixos.filter((r) => r.tipo === "saida"));
  const totalCartao = sum(cartao);
  const totalAvulso = sum(avulso.filter((r) => r.tipo === "saida"));
  const avulsoEntrada = sum(avulso.filter((r) => r.tipo === "entrada"));

  // Fatura separada por cartão, para saber quanto vem de cada um.
  const porCartao = {};
  for (const c of cartao.filter((r) => r.active)) {
    const nome = c.card_name || "Cartão";
    porCartao[nome] = round2((porCartao[nome] || 0) + Number(c.amount));
  }

  const previsto = round2(
    receitasFixas + avulsoEntrada - despesasFixas - totalCartao - totalAvulso
  );

  return {
    month, year,
    fixos, cartao, avulso,
    receitas_fixas: receitasFixas,
    despesas_fixas: despesasFixas,
    total_cartao: totalCartao,
    total_avulso: totalAvulso,
    entradas_avulsas: avulsoEntrada,
    total_previsto_saidas: round2(despesasFixas + totalCartao + totalAvulso),
    total_previsto_entradas: round2(receitasFixas + avulsoEntrada),
    sobra_prevista: previsto,
    por_cartao: Object.entries(porCartao).map(([name, total]) => ({ name, total })),
  };
}

// Soma das receitas fixas ativas — é o "salário fixo" do usuário.
async function fixedIncome(userId) {
  const row = await db.one(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM planned
      WHERE user_id = $1 AND modo = 'fixo' AND tipo = 'entrada' AND active = true`,
    [userId]
  );
  return round2(row.total);
}

// ── Patrimônio: ativos, bens e consórcios ────────────
// Nenhum destes é lançamento do mês. São o que você *tem* (e, no consórcio,
// também o que ainda deve). Os valores derivados nunca são guardados: saem
// sempre dos campos informados, para não dessincronizar.
function decorateAsset(a) {
  const out = { ...a, quantity: Number(a.quantity) || 0 };

  if (a.kind === "ativo") {
    // Sem preço atual informado, o ativo vale o que custou — nunca inventamos
    // cotação nem consultamos mercado.
    const price = a.current_price != null ? Number(a.current_price) : Number(a.avg_price);
    out.cost = round2(out.quantity * Number(a.avg_price));
    out.value = round2(out.quantity * price);
    out.gain = round2(out.value - out.cost);
    out.gain_pct = out.cost > 0 ? round2((out.gain / out.cost) * 100) : 0;
    out.priced = a.current_price != null;
    out.debt = 0;
  } else if (a.kind === "consorcio") {
    const total = a.installments;
    const paidN = a.installments_paid;
    const parcela = Number(a.installment_amount);
    const left = Math.max(total - paidN, 0);
    out.paid_total = round2(paidN * parcela);
    out.debt = round2(left * parcela);
    out.contract_total = round2(total * parcela);
    // Enquanto não é contemplado, o que você tem é o que já pagou.
    out.value = out.paid_total;
    out.installments_left = left;
    out.progress_pct = total > 0 ? round2((paidN / total) * 100) : 0;
    out.years_left = round2(left / 12);
    out.payoff_date = payoffDate(a.start_date, total, paidN);
  } else {
    out.value = round2(Number(a.value));
    out.debt = 0;
  }
  return out;
}

// Mês em que a última parcela cai, contando do início do contrato.
function payoffDate(startDate, total, paid) {
  const left = Math.max(total - paid, 0);
  if (!left) return null;
  const base = startDate ? new Date(startDate + "T00:00:00") : new Date();
  // Com data de início conhecida, a última parcela é a de número `total`.
  // Sem ela, contamos as que faltam a partir de hoje.
  const months = startDate ? total - 1 : left;
  const d = new Date(base.getFullYear(), base.getMonth() + months, 1);
  return d.toISOString().slice(0, 7);
}

async function getAssets(userId) {
  const rows = await db.query(
    "SELECT * FROM assets WHERE user_id = $1 AND archived = false ORDER BY kind, created_at",
    [userId]
  );
  const list = rows.map(decorateAsset);
  const of = (k) => list.filter((a) => a.kind === k);
  const sum = (l, f) => round2(l.reduce((s, a) => s + f(a), 0));

  const ativos = of("ativo");
  const bens = of("bem");
  const cons = of("consorcio");

  return {
    assets: list,
    ativos, bens, consorcios: cons,
    ativos_value: sum(ativos, (a) => a.value),
    ativos_cost: sum(ativos, (a) => a.cost),
    ativos_gain: sum(ativos, (a) => a.gain),
    bens_value: sum(bens, (a) => a.value),
    consorcio_paid: sum(cons, (a) => a.paid_total),
    consorcio_debt: sum(cons, (a) => a.debt),
    consorcio_monthly: sum(cons, (a) => (a.installments_left > 0 ? Number(a.installment_amount) : 0)),
    total_value: sum(list, (a) => a.value),
    total_debt: sum(list, (a) => a.debt),
  };
}

// Patrimônio líquido: contas + ativos + bens − o que ainda se deve.
async function getNetWorth(userId) {
  const accounts = await getAccounts(userId);
  const assets = await getAssets(userId);
  const accountsTotal = round2(accounts.reduce((s, a) => s + a.balance, 0));
  return {
    accounts_total: accountsTotal,
    assets_total: assets.total_value,
    debt_total: assets.total_debt,
    net_worth: round2(accountsTotal + assets.total_value - assets.total_debt),
    assets,
  };
}

module.exports = {
  DEFAULT_SETTINGS, round2,
  getSettings, saveSettings,
  getAccounts, getReserve, getInvestments,
  getSummary, averageMonthlyExpense,
  getPlanned, fixedIncome,
  getAssets, getNetWorth,
};
