// Camada de acesso ao Postgres + migrações.
// O schema é criado/atualizado no arranque; cada migração é idempotente.

const { Pool, types } = require("pg");

// NUMERIC chega como string por padrão — converter para número.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
// DATE deve ficar como "YYYY-MM-DD"; deixar o driver criar um Date desloca o dia
// consoante o fuso do servidor.
types.setTypeParser(1082, (v) => v);

const CONNECTION = process.env.DATABASE_URL;
if (!CONNECTION) {
  console.error("✖ DATABASE_URL não definida. O FinTrack precisa de um Postgres.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: CONNECTION,
  max: 10,
  idleTimeoutMillis: 30000,
  ssl: /sslmode=require/.test(CONNECTION) ? { rejectUnauthorized: false } : false,
});

pool.on("error", (err) => console.error("Postgres pool:", err.message));

async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

async function one(text, params) {
  const rows = await query(text, params);
  return rows[0] || null;
}

// Corre `fn` dentro de uma transação, com rollback automático em erro.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  telegram_chat_id TEXT,
  whatsapp_jid   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('corrente','reserva','investimento','meta')),
  institution     TEXT DEFAULT '',
  goal            NUMERIC(14,2) DEFAULT 0,
  expected_yield  NUMERIC(6,2) DEFAULT 0,
  opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  target_date     DATE,
  archived        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  tipo        TEXT NOT NULL CHECK (tipo IN ('entrada','saida','aporte','resgate','rendimento')),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  category    TEXT NOT NULL DEFAULT 'outros',
  description TEXT NOT NULL DEFAULT '',
  origin      TEXT NOT NULL DEFAULT 'outro',
  source      TEXT NOT NULL DEFAULT 'manual',
  account_id  INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- lançamentos de conta obrigam a ter conta; entradas/saídas não têm
  CONSTRAINT account_required CHECK (
    (tipo IN ('aporte','resgate','rendimento') AND account_id IS NOT NULL)
    OR (tipo IN ('entrada','saida'))
  )
);

CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   JSONB NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS budgets (
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, category)
);

-- Planeamento: o que ainda não aconteceu mas já é esperado.
--   fixo   → repete todos os meses (salário, aluguel, internet)
--   cartao → cai numa fatura concreta; parcelas viram uma linha por mês
--   avulso → gasto previsto só naquele mês
CREATE TABLE IF NOT EXISTS planned (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tipo           TEXT NOT NULL CHECK (tipo IN ('entrada','saida')),
  modo           TEXT NOT NULL CHECK (modo IN ('fixo','cartao','avulso')),
  name           TEXT NOT NULL,
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  category       TEXT NOT NULL DEFAULT 'outros',
  due_day        INTEGER CHECK (due_day BETWEEN 1 AND 31),
  ref_month      DATE,
  card_name      TEXT NOT NULL DEFAULT '',
  installments   INTEGER NOT NULL DEFAULT 1,
  installment_no INTEGER NOT NULL DEFAULT 1,
  group_id       TEXT,
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- item fixo precisa de dia; item de mês precisa do mês
  CONSTRAINT planned_shape CHECK (
    (modo = 'fixo' AND ref_month IS NULL)
    OR (modo IN ('cartao','avulso') AND ref_month IS NOT NULL)
  )
);

-- Patrimônio: o que vale dinheiro mas não é lançamento do mês.
--   ativo     → ação ou fundo imobiliário (quantidade × preço)
--   bem       → carro, moto, imóvel (valor de mercado informado)
--   consorcio → carta de crédito paga em parcelas (é bem e dívida ao mesmo tempo)
CREATE TABLE IF NOT EXISTS assets (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('ativo','bem','consorcio')),
  name               TEXT NOT NULL,
  -- ativo
  ticker             TEXT NOT NULL DEFAULT '',
  quantity           NUMERIC(16,6) NOT NULL DEFAULT 0,
  avg_price          NUMERIC(14,2) NOT NULL DEFAULT 0,
  current_price      NUMERIC(14,2),
  -- bem
  value              NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- consórcio
  installments       INTEGER NOT NULL DEFAULT 0,
  installments_paid  INTEGER NOT NULL DEFAULT 0,
  installment_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  start_date         DATE,
  note               TEXT NOT NULL DEFAULT '',
  archived           BOOLEAN NOT NULL DEFAULT false,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- um consórcio não pode ter mais parcelas pagas do que contratadas
  CONSTRAINT assets_paid_shape CHECK (installments_paid BETWEEN 0 AND GREATEST(installments, 0))
);

CREATE INDEX IF NOT EXISTS assets_user_idx ON assets (user_id, kind) WHERE archived = false;

CREATE INDEX IF NOT EXISTS planned_user_idx  ON planned (user_id, modo);
CREATE INDEX IF NOT EXISTS planned_month_idx ON planned (user_id, ref_month);
CREATE INDEX IF NOT EXISTS planned_group_idx ON planned (group_id);

-- Bancos criados antes da conta corrente têm o CHECK antigo, que recusa
-- 'corrente'. Recriar a restrição é idempotente e não toca nos dados.
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check
  CHECK (kind IN ('corrente','reserva','investimento','meta'));

CREATE INDEX IF NOT EXISTS tx_user_date_idx    ON transactions (user_id, date DESC);
CREATE INDEX IF NOT EXISTS tx_account_idx      ON transactions (account_id);
CREATE INDEX IF NOT EXISTS accounts_user_idx   ON accounts (user_id) WHERE archived = false;
CREATE INDEX IF NOT EXISTS users_telegram_idx  ON users (telegram_chat_id);
CREATE INDEX IF NOT EXISTS users_whatsapp_idx  ON users (whatsapp_jid);
`;

async function init() {
  await pool.query(MIGRATIONS);
  console.log("   DB:   ✅ Postgres pronto (schema verificado)");
}

module.exports = { pool, query, one, tx, init };
