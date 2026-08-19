// Cotações da B3 pela brapi.dev.
//
// Só o endpoint de lista é aberto (a cotação individual pede token), mas ele
// devolve preço, variação, setor e logo de ~2000 papéis de uma vez — o que
// basta. Guardamos em memória e atualizamos a cada 15 minutos: a bolsa não
// muda tanto assim para uma app de finanças pessoais, e assim uma busca do
// usuário não vira uma chamada externa.

const URL_LISTA = "https://brapi.dev/api/quote/list";
const VALIDADE = 15 * 60 * 1000;
const TIMEOUT = 20000;

let cache = { em: 0, papeis: [], porCodigo: new Map(), erro: null };
let buscando = null;

// Tipos que interessam a quem investe pessoa física.
const TIPOS = {
  acao: (p) => p.type === "stock",
  fii: (p) => p.type === "fund" && (p.subType === "fii" || p.subType === "fi-agro"),
  etf: (p) => p.type === "fund" && p.subType === "etf",
  bdr: (p) => p.type === "bdr",
};

function classificar(p) {
  for (const [nome, teste] of Object.entries(TIPOS)) if (teste(p)) return nome;
  return "outro";
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

function normalizar(bruto) {
  return (bruto || [])
    .filter((p) => p && p.stock && Number.isFinite(Number(p.close)))
    .map((p) => ({
      codigo: p.stock,
      nome: p.name && p.name !== p.stock ? p.name : "",
      preco: Number(p.close),
      variacao: Number(p.change) || 0,
      setor: p.sector || "",
      subsetor: p.subsector || "",
      logo: p.logo || null,
      tipo: classificar(p),
      volume: Number(p.volume) || 0,
      // Volume em reais. Ordenar por nº de ações põe papel de R$0,20 à frente
      // do Itaú; em dinheiro negociado a lista fica realista.
      giro: (Number(p.volume) || 0) * Number(p.close),
    }));
}

async function atualizar() {
  // Se já há uma busca em curso, espera por ela em vez de disparar outra.
  if (buscando) return buscando;

  buscando = (async () => {
    try {
      const res = await fetch(URL_LISTA, {
        headers: { "User-Agent": "FinTrack/5" },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) throw new Error("brapi respondeu " + res.status);

      const dados = await res.json();
      const papeis = normalizar(dados.stocks);
      if (!papeis.length) throw new Error("lista veio vazia");

      cache = {
        em: Date.now(),
        papeis,
        porCodigo: new Map(papeis.map((p) => [p.codigo, p])),
        erro: null,
      };
      console.log(`   Bolsa:✅ ${papeis.length} papéis atualizados`);
    } catch (err) {
      // Mantém o cache velho: preço de 1h atrás é melhor que tela vazia.
      cache.erro = err.message;
      console.error("Cotações:", err.message);
    } finally {
      buscando = null;
    }
    return cache;
  })();

  return buscando;
}

async function garantir() {
  if (Date.now() - cache.em > VALIDADE) await atualizar();
  return cache;
}

/** Busca por código ou nome. Código exato vem primeiro. */
async function buscar(termo, { tipo = null, limite = 20 } = {}) {
  const c = await garantir();
  const q = norm(termo).trim();

  let lista = c.papeis;
  if (tipo && TIPOS[tipo]) lista = lista.filter((p) => p.tipo === tipo);
  if (!q) {
    // Sem termo: os mais negociados. Fora índices e afins ("outro"), que
    // aparecem na lista da B3 mas ninguém compra.
    return lista.filter((p) => p.tipo !== "outro").sort((a, b) => b.giro - a.giro).slice(0, limite);
  }

  const pontos = (p) => {
    const cod = norm(p.codigo), nom = norm(p.nome);
    if (cod === q) return 100;
    if (cod.startsWith(q)) return 80;
    if (nom.startsWith(q)) return 60;
    if (cod.includes(q)) return 40;
    if (nom.includes(q)) return 20;
    return 0;
  };

  return lista
    .map((p) => ({ p, s: pontos(p) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.p.giro - a.p.giro)
    .slice(0, limite)
    .map((x) => x.p);
}

/** Preço atual de vários códigos de uma vez. */
async function precos(codigos) {
  const c = await garantir();
  const out = {};
  for (const cod of codigos) {
    const p = c.porCodigo.get(String(cod).toUpperCase());
    if (p) out[p.codigo] = { preco: p.preco, variacao: p.variacao, nome: p.nome, logo: p.logo, tipo: p.tipo };
  }
  return out;
}

const existe = async (codigo) => (await garantir()).porCodigo.has(String(codigo).toUpperCase());
const info = async (codigo) => (await garantir()).porCodigo.get(String(codigo).toUpperCase()) || null;

const estado = () => ({
  papeis: cache.papeis.length,
  atualizado: cache.em ? new Date(cache.em).toISOString() : null,
  minutos: cache.em ? Math.round((Date.now() - cache.em) / 60000) : null,
  erro: cache.erro,
});

module.exports = { buscar, precos, existe, info, estado, atualizar, TIPOS };
