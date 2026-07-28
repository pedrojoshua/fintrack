// Camada de acesso ao Postgres + migrações.
// O schema é criado/atualizado no arranque; cada migração é idempotente.

const { Pool, types } = require("pg");

// NUMERIC chega como string por omissão — converter para número.
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
  kind            TEXT NOT NULL CHECK (kind IN ('reserva','investimento','meta')),
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
  -- movimentos de conta obrigam a ter conta; entradas/saídas não têm
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
