// Rotas HTTP da aplicação. Tudo abaixo de /api exige token, exceto auth e status.

const express = require("express");
const db = require("./db");
const auth = require("./auth");
const money = require("./money");
const cats = require("./categories");

const router = express.Router();

const TIPOS = ["entrada", "saida", "aporte", "resgate", "rendimento"];
const KINDS = ["reserva", "investimento", "meta"];
const ACCOUNT_TIPOS = ["aporte", "resgate", "rendimento"];

// ── Validação ────────────────────────────────────────
function parseAmount(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function parseDate(v) {
  if (!v) return new Date().toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

const clean = (v, max = 200) => String(v ?? "").trim().slice(0, max);

// Envolve handlers async para que erros caiam no middleware de erro.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ════════════════════════════════════════════════════
//  AUTENTICAÇÃO
// ════════════════════════════════════════════════════
router.get("/auth/state", wrap(async (_req, res) => {
  const row = await db.one("SELECT COUNT(*)::int AS n FROM users");
  res.json({ registered: row.n > 0 });
}));

router.post("/auth/setup", wrap(async (req, res) => {
  const existing = await db.one("SELECT COUNT(*)::int AS n FROM users");
  if (existing.n > 0) return res.status(409).json({ error: "Já existe uma conta. Faz login." });

  const username = clean(req.body.username, 40);
  const password = String(req.body.password || "");
  if (username.length < 3) return res.status(400).json({ error: "Utilizador com pelo menos 3 caracteres." });
  if (password.length < 8) return res.status(400).json({ error: "Senha com pelo menos 8 caracteres." });

  const hash = await auth.hashPassword(password);
  const user = await db.one(
    "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
    [username, hash]
  );

  // Conta de reserva por omissão — o painel nasce útil em vez de vazio.
  await db.query(
    `INSERT INTO accounts (user_id, name, kind, institution) VALUES ($1, 'Reserva de Emergência', 'reserva', '')`,
    [user.id]
  );

  res.status(201).json({ token: auth.signToken(user.id, user.username), username: user.username });
}));

router.post("/auth/login", wrap(async (req, res) => {
  const username = clean(req.body.username, 40);
  const password = String(req.body.password || "");

  const user = await db.one("SELECT id, username, password_hash FROM users WHERE username = $1", [username]);
  // Mensagem igual nos dois casos — não revela se o utilizador existe.
  const fail = () => res.status(401).json({ error: "Utilizador ou senha incorretos." });
  if (!user) {
    await auth.checkPassword(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin");
    return fail();
  }
  if (!(await auth.checkPassword(password, user.password_hash))) return fail();

  res.json({ token: auth.signToken(user.id, user.username), username: user.username });
}));

router.get("/auth/me", auth.requireAuth, wrap(async (req, res) => {
  const u = await db.one(
    "SELECT username, telegram_chat_id, whatsapp_jid FROM users WHERE id = $1",
    [req.user.id]
  );
  res.json({
    username: u.username,
    telegram_linked: !!u.telegram_chat_id,
    whatsapp_linked: !!u.whatsapp_jid,
  });
}));

router.post("/auth/password", auth.requireAuth, wrap(async (req, res) => {
  const current = String(req.body.current || "");
  const next = String(req.body.next || "");
  if (next.length < 8) return res.status(400).json({ error: "A nova senha precisa de 8 caracteres." });

  const user = await db.one("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!(await auth.checkPassword(current, user.password_hash))) {
    return res.status(401).json({ error: "Senha atual incorreta." });
  }
  await db.query("UPDATE users SET password_hash = $1 WHERE id = $2", [await auth.hashPassword(next), req.user.id]);
  res.json({ ok: true });
}));

// ════════════════════════════════════════════════════
//  A partir daqui, tudo autenticado
// ════════════════════════════════════════════════════
router.use(auth.requireAuth);

router.get("/categories", (_req, res) => res.json({ out: cats.OUT, in: cats.IN, origins: cats.ORIGINS }));

// ── Movimentos ───────────────────────────────────────
router.get("/transactions", wrap(async (req, res) => {
  const { month, year, tipo, category, q, limit } = req.query;
  const where = ["t.user_id = $1"];
  const params = [req.user.id];

  if (month && year) {
    params.push(`${year}-${String(month).padStart(2, "0")}-01`);
    where.push(`t.date >= $${params.length}::date AND t.date < ($${params.length}::date + INTERVAL '1 month')`);
  }
  if (tipo && TIPOS.includes(tipo)) {
    params.push(tipo);
    where.push(`t.tipo = $${params.length}`);
  }
  if (category) {
    params.push(category);
    where.push(`t.category = $${params.length}`);
  }
  if (q) {
    params.push(`%${clean(q, 60)}%`);
    where.push(`t.description ILIKE $${params.length}`);
  }
  const max = Math.min(Number(limit) || 500, 2000);

  const rows = await db.query(
    `SELECT t.*, a.name AS account_name, a.kind AS account_kind
       FROM transactions t
       LEFT JOIN accounts a ON a.id = t.account_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.date DESC, t.id DESC
      LIMIT ${max}`,
    params
  );
  res.json(rows);
}));

router.post("/transactions", wrap(async (req, res) => {
  const b = req.body || {};
  const tipo = TIPOS.includes(b.tipo) ? b.tipo : null;
  if (!tipo) return res.status(400).json({ error: "Tipo inválido." });

  const amount = parseAmount(b.amount);
  if (amount === null) return res.status(400).json({ error: "Valor tem de ser maior que zero." });

  const date = parseDate(b.date);
  if (!date) return res.status(400).json({ error: "Data inválida." });

  let accountId = null;
  if (ACCOUNT_TIPOS.includes(tipo)) {
    accountId = Number(b.account_id);
    if (!accountId) return res.status(400).json({ error: "Escolhe a conta para este movimento." });
    const acc = await db.one("SELECT id FROM accounts WHERE id = $1 AND user_id = $2", [accountId, req.user.id]);
    if (!acc) return res.status(404).json({ error: "Conta não encontrada." });
  }

  const category = ACCOUNT_TIPOS.includes(tipo) ? tipo : clean(b.category, 40) || "outros";

  const row = await db.one(
    `INSERT INTO transactions (user_id, date, tipo, amount, category, description, origin, source, account_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.user.id, date, tipo, amount, category, clean(b.description, 200),
     clean(b.origin, 30) || "outro", clean(b.source, 20) || "manual", accountId]
  );
  res.status(201).json(row);
}));

router.patch("/transactions/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const owned = await db.one("SELECT id, tipo FROM transactions WHERE id = $1 AND user_id = $2", [id, req.user.id]);
  if (!owned) return res.status(404).json({ error: "Movimento não encontrado." });

  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  const b = req.body || {};
  if (b.amount !== undefined) {
    const a = parseAmount(b.amount);
    if (a === null) return res.status(400).json({ error: "Valor inválido." });
    push("amount", a);
  }
  if (b.date !== undefined) {
    const d = parseDate(b.date);
    if (!d) return res.status(400).json({ error: "Data inválida." });
    push("date", d);
  }
  // A categoria de movimentos de conta é fixa pelo tipo; não se edita.
  if (b.category !== undefined && !ACCOUNT_TIPOS.includes(owned.tipo)) push("category", clean(b.category, 40));
  if (b.description !== undefined) push("description", clean(b.description, 200));
  if (b.origin !== undefined) push("origin", clean(b.origin, 30));

  if (!sets.length) return res.status(400).json({ error: "Nada para atualizar." });

  params.push(id, req.user.id);
  const row = await db.one(
    `UPDATE transactions SET ${sets.join(", ")}
      WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
    params
  );
  res.json(row);
}));

router.delete("/transactions/:id", wrap(async (req, res) => {
  const row = await db.one(
    "DELETE FROM transactions WHERE id = $1 AND user_id = $2 RETURNING id",
    [Number(req.params.id), req.user.id]
  );
  if (!row) return res.status(404).json({ error: "Movimento não encontrado." });
  res.json({ ok: true });
}));

// ── Contas (reserva / investimentos / metas) ─────────
router.get("/accounts", wrap(async (req, res) => {
  res.json(await money.getAccounts(req.user.id, { includeArchived: req.query.all === "1" }));
}));

router.post("/accounts", wrap(async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 60);
  if (!name) return res.status(400).json({ error: "Dá um nome à conta." });
  if (!KINDS.includes(b.kind)) return res.status(400).json({ error: "Tipo de conta inválido." });

  const row = await db.one(
    `INSERT INTO accounts (user_id, name, kind, institution, goal, expected_yield, opening_balance, target_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [req.user.id, name, b.kind, clean(b.institution, 60),
     Number(b.goal) || 0, Number(b.expected_yield) || 0,
     Number(b.opening_balance) || 0, parseDate(b.target_date) || null]
  );
  res.status(201).json(row);
}));

router.patch("/accounts/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const owned = await db.one("SELECT id FROM accounts WHERE id = $1 AND user_id = $2", [id, req.user.id]);
  if (!owned) return res.status(404).json({ error: "Conta não encontrada." });

  const sets = [];
  const params = [];
  const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

  const b = req.body || {};
  if (b.name !== undefined) push("name", clean(b.name, 60));
  if (b.institution !== undefined) push("institution", clean(b.institution, 60));
  if (b.goal !== undefined) push("goal", Number(b.goal) || 0);
  if (b.expected_yield !== undefined) push("expected_yield", Number(b.expected_yield) || 0);
  if (b.opening_balance !== undefined) push("opening_balance", Number(b.opening_balance) || 0);
  if (b.target_date !== undefined) push("target_date", parseDate(b.target_date) || null);
  if (b.archived !== undefined) push("archived", !!b.archived);
  if (b.kind !== undefined && KINDS.includes(b.kind)) push("kind", b.kind);

  if (!sets.length) return res.status(400).json({ error: "Nada para atualizar." });

  params.push(id, req.user.id);
  const row = await db.one(
    `UPDATE accounts SET ${sets.join(", ")}
      WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
    params
  );
  res.json(row);
}));

// Apagar uma conta leva os seus movimentos (ON DELETE CASCADE) — avisar no cliente.
router.delete("/accounts/:id", wrap(async (req, res) => {
  const row = await db.one(
    "DELETE FROM accounts WHERE id = $1 AND user_id = $2 RETURNING id",
    [Number(req.params.id), req.user.id]
  );
  if (!row) return res.status(404).json({ error: "Conta não encontrada." });
  res.json({ ok: true });
}));

// ── Painéis ──────────────────────────────────────────
router.get("/summary", wrap(async (req, res) => {
  const now = new Date();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const year = Number(req.query.year) || now.getFullYear();
  if (month < 1 || month > 12) return res.status(400).json({ error: "Mês inválido." });
  res.json(await money.getSummary(req.user.id, month, year));
}));

router.get("/reserve", wrap(async (req, res) => res.json(await money.getReserve(req.user.id))));
router.get("/investments", wrap(async (req, res) => res.json(await money.getInvestments(req.user.id))));

// ── Definições e orçamentos ──────────────────────────
router.get("/settings", wrap(async (req, res) => res.json(await money.getSettings(req.user.id))));
router.post("/settings", wrap(async (req, res) => res.json(await money.saveSettings(req.user.id, req.body || {}))));

router.get("/budgets", wrap(async (req, res) => {
  res.json(await db.query("SELECT category, amount FROM budgets WHERE user_id = $1", [req.user.id]));
}));

router.post("/budgets", wrap(async (req, res) => {
  const category = clean(req.body.category, 40);
  const amount = Number(req.body.amount) || 0;
  if (!category) return res.status(400).json({ error: "Categoria em falta." });

  if (amount <= 0) {
    await db.query("DELETE FROM budgets WHERE user_id = $1 AND category = $2", [req.user.id, category]);
    return res.json({ ok: true, removed: true });
  }
  await db.query(
    `INSERT INTO budgets (user_id, category, amount) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, category) DO UPDATE SET amount = EXCLUDED.amount`,
    [req.user.id, category, amount]
  );
  res.json({ ok: true });
}));

// ── Canais de mensagem ───────────────────────────────
const whatsapp = require("./channels/whatsapp");

router.get("/channels", wrap(async (req, res) => {
  const u = await db.one("SELECT telegram_chat_id, whatsapp_jid FROM users WHERE id = $1", [req.user.id]);
  const state = whatsapp.ENABLED ? await whatsapp.connectionState() : "desativado";
  res.json({
    whatsapp: {
      enabled: whatsapp.ENABLED,
      state,                          // open = ligado ao telemóvel
      linked: !!u.whatsapp_jid,
      number: u.whatsapp_jid || null,
      instance: whatsapp.INSTANCE,
    },
    telegram: {
      enabled: !!process.env.TELEGRAM_TOKEN,
      linked: !!u.telegram_chat_id,
    },
  });
}));

// QR para ligar o WhatsApp. Só faz sentido quando o estado não é "open".
router.post("/channels/whatsapp/connect", wrap(async (_req, res) => {
  if (!whatsapp.ENABLED) return res.status(503).json({ error: "WhatsApp não configurado no servidor." });
  const state = await whatsapp.connectionState();
  if (state === "open") return res.json({ state, qr: null, message: "Já está ligado." });

  const qr = await whatsapp.getQrCode();
  if (!qr) return res.status(502).json({ error: "Não consegui obter o QR. Tenta outra vez." });
  res.json({ state, qr });
}));

router.post("/channels/whatsapp/logout", wrap(async (req, res) => {
  await whatsapp.logout();
  await db.query("UPDATE users SET whatsapp_jid = NULL WHERE id = $1", [req.user.id]);
  res.json({ ok: true });
}));

// Código de 6 dígitos, válido 10 minutos, para ligar o Telegram.
router.post("/channels/telegram/code", wrap(async (req, res) => {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const value = { code, exp: Date.now() + 10 * 60 * 1000 };
  await db.query(
    `INSERT INTO settings (user_id, key, value) VALUES ($1, 'link_code', $2)
     ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [req.user.id, JSON.stringify(value)]
  );
  res.json({ code, expires_in: 600 });
}));

router.post("/channels/telegram/unlink", wrap(async (req, res) => {
  await db.query("UPDATE users SET telegram_chat_id = NULL WHERE id = $1", [req.user.id]);
  res.json({ ok: true });
}));

// ── Exportação ───────────────────────────────────────
router.get("/export.csv", wrap(async (req, res) => {
  const rows = await db.query(
    `SELECT t.date, t.tipo, t.amount, t.category, t.description, t.origin, t.source, a.name AS conta
       FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.user_id = $1 ORDER BY t.date DESC, t.id DESC`,
    [req.user.id]
  );
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [
    "data;tipo;valor;categoria;descricao;origem;fonte;conta",
    ...rows.map((r) => [r.date, r.tipo, String(r.amount).replace(".", ","), r.category,
                        r.description, r.origin, r.source, r.conta || ""].map(esc).join(";")),
  ].join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="fintrack-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send("﻿" + csv); // BOM para o Excel abrir com acentos certos
}));

module.exports = router;
