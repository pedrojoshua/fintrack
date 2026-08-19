// Interpretadores de campo único.
//
// O usuário pediu explicitamente um campo só por assunto — formulário com
// muitos campos "parece amador". Então cada cadastro aceita uma frase e o
// servidor separa os pedaços. Se a frase não bastar, devolvemos `falta` para
// a tela perguntar só o que ficou por dizer, em vez de mostrar tudo de uma vez.

// Números em pt-BR: 1.234,56 | 32,50 | 850 | 18k
function numero(txt) {
  if (txt == null) return null;
  let s = String(txt).trim().toLowerCase();

  const mil = /^(\d+(?:[.,]\d+)?)\s*(k|mil)$/.exec(s);
  if (mil) return parseFloat(mil[1].replace(",", ".")) * 1000;

  s = s.replace(/[r$\s]/g, "");
  if (!s) return null;

  // Com vírgula, ela é o decimal e o ponto é milhar. Sem vírgula, um ponto
  // só é decimal se não separar exatamente 3 dígitos (1.500 é mil e quinhentos).
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d+\.\d{3}$/.test(s)) s = s.replace(".", "");

  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// Todos os números de uma frase, na ordem em que aparecem.
function numeros(texto) {
  const achados = String(texto || "").match(/\d+(?:[.,]\d+)*\s*(?:k|mil)?/gi) || [];
  return achados.map(numero).filter((n) => n !== null && n > 0);
}

const CODIGO = /\b([A-Z]{4}\d{1,2})\b/;

/**
 * Compra de papel: "PETR4 100 32,50" | "comprei 50 MXRF11 a 9,25" | "PETR4 100"
 * Sem o preço, devolve falta:"preco_medio" — daí a tela usa a cotação do dia.
 */
function compra(texto) {
  const t = String(texto || "").trim();
  if (!t) return { erro: "Escreva o papel, quantas cotas e quanto pagou." };

  const cod = CODIGO.exec(t.toUpperCase());
  if (!cod) return { erro: "Não achei o código do papel (ex.: PETR4, MXRF11)." };
  const ticker = cod[1];

  // Tira o código antes de ler os números, senão o "4" de PETR4 entraria na conta.
  const nums = numeros(t.toUpperCase().replace(ticker, " "));
  if (!nums.length) return { ticker, falta: "quantidade" };

  // A quantidade é sempre o primeiro número; o preço, o segundo.
  const [quantidade, preco_medio] = nums;
  if (preco_medio === undefined) return { ticker, quantidade, falta: "preco_medio" };
  return { ticker, quantidade, preco_medio };
}

/**
 * Bem: "Moto Honda CB 300 18000" | "Carro 45 mil" | "Moto R$ 18.000"
 * O último número é o valor; o resto vira o nome.
 */
function bem(texto) {
  const t = String(texto || "").trim();
  if (!t) return { erro: "Escreva o que é e quanto vale." };

  const nums = numeros(t);
  if (!nums.length) return { erro: "Não achei o valor. Ex.: Moto Honda 18000" };

  const valor = nums[nums.length - 1];

  // Remove só a última ocorrência do valor, para "CB 300" continuar no nome.
  const bruto = (t.match(/\d+(?:[.,]\d+)*\s*(?:k|mil)?/gi) || []).pop();
  const corte = t.lastIndexOf(bruto);
  const name = (t.slice(0, corte) + t.slice(corte + bruto.length))
    .replace(/r?\$/gi, " ")
    .replace(/\b(r|vale|custa|de|por|no valor)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!name) return { valor, falta: "name" };
  return { name: name.charAt(0).toUpperCase() + name.slice(1), valor };
}

/**
 * Consórcio: "Consórcio imóvel 80000 em 120 parcelas de 850, paguei 12"
 *            "Consórcio Honda 120x 850"
 * Pistas de palavra vencem a ordem dos números — "120 parcelas" é prazo,
 * mesmo vindo antes do valor da carta.
 */
function consorcio(texto) {
  const t = String(texto || "").trim();
  if (!t) return { erro: "Escreva o consórcio, o prazo e a parcela." };
  const low = t.toLowerCase();

  // Cada pista consome o número que leu, para ele não ser reaproveitado
  // depois como se fosse o valor da carta.
  const usados = [];
  const pega = (rx) => {
    const m = rx.exec(low);
    if (!m) return null;
    const n = numero(m[1]);
    if (n !== null) usados.push(n);
    return n;
  };

  // "120000 parcela 900" também casa com o padrão de prazo, então descartamos
  // candidatos absurdos: ninguém tem consórcio de mais de 600 meses.
  let parcelas_total = null;
  for (const m of low.matchAll(/(\d[\d.,]*)\s*(?:x|parcelas?|meses|vezes)\b/g)) {
    const n = numero(m[1]);
    if (n && Number.isInteger(n) && n <= 600) { parcelas_total = n; usados.push(n); break; }
  }
  const parcelaClara = pega(/parcelas?\s*(?:de|:)?\s*(?:r\$)?\s*([\d.,]+)/)
                    ?? pega(/(?:de|x)\s*r\$\s*([\d.,]+)/);
  let parcela_valor = parcelaClara;
  const parcelas_pagas = pega(/(?:paguei|pagas?|quitei)\s*(\d+)/) ?? 0;

  // Prazo escrito em anos vira meses.
  const anos = pega(/(\d+)\s*anos?\b/);
  if (!parcelas_total && anos) parcelas_total = anos * 12;

  // Números que nenhuma pista reclamou.
  const livres = numeros(low).filter((n) => !usados.includes(n));

  let goal = null;
  if (livres.length >= 2) {
    // Com dois números soltos, o maior é a carta e o menor é a parcela.
    goal = Math.max(...livres);
    if (!parcela_valor) parcela_valor = Math.min(...livres);
  } else if (livres.length === 1) {
    // Com um só: se a parcela ainda falta, "120x 850" quer dizer a parcela;
    // se a parcela já é conhecida, o número solto é a carta.
    if (!parcela_valor) parcela_valor = livres[0];
    else goal = livres[0];
  }
  if (goal && parcela_valor && goal < parcela_valor && !parcelaClara) {
    [goal, parcela_valor] = [parcela_valor, goal];
  }

  // Sem a carta declarada, dá para deduzir: parcela × prazo.
  if (!goal && parcela_valor && parcelas_total) goal = parcela_valor * parcelas_total;

  const name = t.replace(/[\d.,]+\s*(?:x|k|mil|parcelas?|meses|vezes|anos?)?/gi, " ")
    .replace(/r?\$/g, " ")
    .replace(/\b(r|de|em|paguei|pagas?|quitei|parcelas?|valor|total)\b/gi, " ")
    .replace(/[,;]/g, " ").replace(/\s{2,}/g, " ").trim();

  if (!parcela_valor) return { name, parcelas_total, falta: "parcela_valor" };
  if (!parcelas_total) return { name, parcela_valor, falta: "parcelas_total" };

  return {
    name: name ? name.charAt(0).toUpperCase() + name.slice(1) : "Consórcio",
    goal: goal || parcela_valor * parcelas_total,
    parcela_valor,
    parcelas_total,
    parcelas_pagas: Math.min(parcelas_pagas, parcelas_total),
  };
}

/**
 * De que assunto é a frase? Descobrir isto no servidor é o que permite ter um
 * campo só na tela: o usuário escreve e não escolhe categoria nenhuma.
 *
 * Ordem importa. "Consórcio Honda 120x 850" tem cara de bem e de consórcio;
 * a pista de parcelamento decide primeiro.
 */
function detectar(texto) {
  const t = String(texto || "");
  const low = t.toLowerCase();

  if (/cons[óo]rcio|financiamento|\bparcelas?\b|\b\d+\s*x\b|\b\d+\s*(?:meses|vezes)\b/.test(low)) {
    return "consorcio";
  }
  if (CODIGO.test(t.toUpperCase())) return "ativo";
  return "bem";
}

module.exports = { compra, bem, consorcio, detectar, numero, numeros };
