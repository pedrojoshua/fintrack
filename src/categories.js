// Catálogo de categorias e deteção automática a partir do texto livre.

const OUT = [
  { id: "alimentação", icon: "🛒", label: "Alimentação" },
  { id: "casa",        icon: "🏠", label: "Casa" },
  { id: "transporte",  icon: "🚗", label: "Transporte" },
  { id: "saúde",       icon: "💊", label: "Saúde" },
  { id: "lazer",       icon: "🎬", label: "Lazer" },
  { id: "assinaturas", icon: "🔁", label: "Assinaturas" },
  { id: "educação",    icon: "📚", label: "Educação" },
  { id: "vestuário",   icon: "👔", label: "Vestuário" },
  { id: "dívidas",     icon: "🏦", label: "Dívidas" },
  { id: "impostos",    icon: "📄", label: "Impostos" },
  { id: "pets",        icon: "🐾", label: "Pets" },
  { id: "presentes",   icon: "🎁", label: "Presentes" },
  { id: "casamento",   icon: "💍", label: "Casamento" },
  { id: "outros",      icon: "📦", label: "Outros" },
];

const IN = [
  { id: "salário",      icon: "💼", label: "Salário" },
  { id: "freelance",    icon: "💻", label: "Freelance" },
  { id: "pix recebido", icon: "📲", label: "Pix recebido" },
  { id: "venda",        icon: "🛍", label: "Venda" },
  { id: "reembolso",    icon: "↩️", label: "Reembolso" },
  { id: "rendimento",   icon: "📈", label: "Rendimento" },
  { id: "outros",       icon: "📦", label: "Outros" },
];

const ORIGINS = ["pix", "débito", "crédito", "dinheiro", "boleto", "transferência", "outro"];

// Palavras-chave por categoria. Escritas sem acento — o texto é normalizado antes.
const KW_OUT = {
  "alimentação": ["mercado","supermercado","ifood","rappi","restaurante","comida","almoco","jantar","cafe","padaria","lanche","pizza","hamburguer","acougue","hortifruti","feira","carrefour","atacadao","assai","extra","pao de acucar","sacolao","delivery","marmita","churrasco","sorvete"],
  "transporte":  ["gasolina","alcool","etanol","combustivel","uber","99","taxi","onibus","metro","estacionamento","pedagio","oficina","mecanico","pneu","revisao","lavagem","brt","passagem","bilhete unico","posto"],
  "casa":        ["aluguel","condominio","luz","energia","agua","gas","internet","wifi","telefone","celular","limpeza","faxina","moveis","reforma","eletricista","encanador","enel","sabesp","comgas","vivo","claro","tim","oi"],
  "saúde":       ["farmacia","remedio","medico","dentista","hospital","consulta","exame","clinica","psicologo","terapia","academia","unimed","amil","hapvida","plano de saude","convenio","oculos","lente","fisioterapia","vacina","droga raia","drogasil","pacheco"],
  "lazer":       ["cinema","bar","festa","viagem","hotel","airbnb","passeio","show","ingresso","jogo","balada","parque","praia","teatro","boliche","pub","cerveja","rolê","role"],
  "assinaturas": ["netflix","spotify","prime","disney","hbo","max","deezer","youtube premium","globoplay","paramount","apple tv","icloud","google one","dropbox","chatgpt","assinatura","mensalidade app","canva","adobe"],
  "educação":    ["curso","livro","faculdade","universidade","escola","material escolar","udemy","alura","rocketseat","ingles","espanhol","apostila","concurso","pos graduacao","mba","workshop"],
  "vestuário":   ["roupa","sapato","tenis","calca","camiseta","camisa","vestido","jaqueta","renner","riachuelo","cea","zara","hering","nike","adidas","meia","cueca","calcado"],
  "dívidas":     ["financiamento","emprestimo","parcela","prestacao","fatura","cartao de credito","banco pan","crediario","refinanciamento","juros","divida","consignado","carne"],
  "impostos":    ["ipva","iptu","imposto","licenciamento","detran","multa","taxa","darf","inss","irpf","cartorio","documento"],
  "pets":        ["pet","veterinario","racao","petshop","banho e tosa","vacina pet","cachorro","gato","antipulgas"],
  "presentes":   ["presente","aniversario","lembranca","natal","dia das maes","dia dos pais","flores"],
  "casamento":   ["casamento","buffet","salao de festa","vestido de noiva","alianca","convite","lua de mel","noiva","noivo","cerimonia","decoracao casamento","padrinho"],
  "outros":      ["shopee","shein","aliexpress","amazon","mercado livre","mercadolivre","magalu","magazine","americanas","kabum","olx","temu"],
};

const KW_IN = {
  "salário":      ["salario","holerite","contracheque","pagamento empresa","folha","lustoza","13o","decimo terceiro","ferias","adiantamento"],
  "freelance":    ["freelance","freela","bico","trabalho extra","servico prestado","projeto","job"],
  "reembolso":    ["reembolso","estorno","devolucao","ressarcimento","cashback"],
  "rendimento":   ["rendimento","dividendo","juros recebidos","lucro","proventos","jcp"],
  "venda":        ["venda","vendi","vendido","revenda"],
  "pix recebido": ["pix"],
};

// Remove acentos e baixa a caixa, para comparar sem sobressaltos.
function norm(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Procura a keyword mais longa que casa — evita que "pix" ganhe de "pix recebido".
function detect(text, table, fallback) {
  const t = norm(text);
  let best = null;
  let bestLen = 0;
  for (const [cat, kws] of Object.entries(table)) {
    for (const kw of kws) {
      const k = norm(kw);
      if (k.length > bestLen && t.includes(k)) {
        best = cat;
        bestLen = k.length;
      }
    }
  }
  return best || fallback;
}

const detectOut = (text) => detect(text, KW_OUT, "outros");
const detectIn  = (text) => detect(text, KW_IN, "outros");

function detectOrigin(text, tipo) {
  const t = norm(text);
  if (t.includes("pix")) return "pix";
  if (t.includes("boleto")) return "boleto";
  if (t.includes("dinheiro") || t.includes("especie")) return "dinheiro";
  if (t.includes("credito") || t.includes("cartao de credito")) return "crédito";
  if (t.includes("debito")) return "débito";
  if (t.includes("transferencia") || t.includes("ted") || t.includes("doc")) return "transferência";
  if (t.includes("cartao")) return "crédito";
  return tipo === "entrada" ? "transferência" : "outro";
}

const ICONS = Object.fromEntries([...OUT, ...IN].map((c) => [c.id, c.icon]));
const iconFor = (cat) => ICONS[cat] || "📦";

module.exports = { OUT, IN, ORIGINS, norm, detectOut, detectIn, detectOrigin, iconFor };
