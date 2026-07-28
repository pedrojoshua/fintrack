// Autenticação: hash bcrypt + tokens HMAC assinados (sobrevivem a reinícios).

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error("✖ SESSION_SECRET em falta ou demasiado curta (mínimo 16 caracteres).");
  process.exit(1);
}

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const ROUNDS = 12;

const hashPassword = (plain) => bcrypt.hash(plain, ROUNDS);
const checkPassword = (plain, hash) => bcrypt.compare(plain, hash);

function signToken(userId, username) {
  const payload = Buffer.from(JSON.stringify({ i: userId, u: username, t: Date.now() })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const idx = token.lastIndexOf(".");
  if (idx < 1) return null;

  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");

  // Comparação em tempo constante — evita timing attacks na assinatura.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (Date.now() - data.t > TOKEN_TTL_MS) return null;
    return { id: data.i, username: data.u };
  } catch {
    return null;
  }
}

function tokenFrom(req) {
  const header = req.headers["authorization"] || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

// Middleware: exige token válido e confirma que o utilizador ainda existe.
async function requireAuth(req, res, next) {
  const claim = verifyToken(tokenFrom(req));
  if (!claim) return res.status(401).json({ error: "Não autenticado." });

  const user = await db.one("SELECT id, username FROM users WHERE id = $1", [claim.id]);
  if (!user) return res.status(401).json({ error: "Sessão inválida." });

  req.user = user;
  next();
}

module.exports = { hashPassword, checkPassword, signToken, verifyToken, tokenFrom, requireAuth };
