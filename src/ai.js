// Leitura de imagens, notificações de banco e áudio.
//
// Imagem e texto vão para o Claude com saída estruturada — o schema garante
// que a resposta é sempre um JSON válido com os campos certos, sem precisar
// de tratar texto solto.
//
// Áudio precisa de transcrição: o Claude não recebe áudio, por isso passa
// por um serviço compatível com Whisper (Groq ou OpenAI).

const Anthropic = require("@anthropic-ai/sdk");
const { OUT, IN, ORIGINS } = require("./categories");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";
const ENABLED = !!process.env.ANTHROPIC_API_KEY;
const client = ENABLED ? new Anthropic() : null;

// Transcrição: qualquer endpoint compatível com a API do Whisper.
const TRANSCRIBE_URL = process.env.TRANSCRIBE_URL || "https://api.groq.com/openai/v1/audio/transcriptions";
const TRANSCRIBE_KEY = process.env.TRANSCRIBE_API_KEY || "";
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "whisper-large-v3-turbo";
const AUDIO_ENABLED = !!TRANSCRIBE_KEY;

const CATS_OUT = OUT.map((c) => c.id);
const CATS_IN = IN.map((c) => c.id);

// O schema é o contrato: a resposta não pode vir fora deste formato.
const SCHEMA = {
  type: "object",
  properties: {
    encontrou: {
      type: "boolean",
      description: "true se há um gasto ou recebimento identificável; false se a imagem/texto não é financeira",
    },
    tipo: { type: "string", enum: ["entrada", "saida"] },
    valor: { type: "number", description: "Valor em reais, sempre positivo" },
    descricao: { type: "string", description: "Estabelecimento ou motivo, curto e legível" },
    categoria: { type: "string", enum: [...new Set([...CATS_OUT, ...CATS_IN])] },
    data: { type: "string", description: "Data no formato AAAA-MM-DD. Se não aparecer, usa a data de hoje." },
    origem: { type: "string", enum: ORIGINS },
    parcelas: { type: "integer", description: "Número de parcelas se for compra parcelada; 1 se à vista" },
    confianca: { type: "string", enum: ["alta", "media", "baixa"] },
    observacao: { type: "string", description: "Vazio normalmente. Só preenche se algo ficou ambíguo." },
  },
  required: ["encontrou", "tipo", "valor", "descricao", "categoria", "data", "origem", "parcelas", "confianca", "observacao"],
  additionalProperties: false,
};

const hoje = () => new Date().toISOString().slice(0, 10);

const INSTRUCOES = `Extrais lançamentos financeiros de comprovantes, notificações de banco e cupons brasileiros.

Regras:
- O valor é sempre positivo. O campo "tipo" diz se é entrada ou saída.
- Compra, pagamento, débito, fatura, saque → saida. Pix recebido, depósito, salário, estorno, cashback → entrada.
- "descricao" é o nome do estabelecimento como uma pessoa o escreveria: "Uber", "Padaria do Zé", "Mercado Livre". Limpa códigos de operadora ("UBER *TRIP BR" → "Uber", "PAG*JOAOSILVA" → "João Silva").
- "categoria" tem de ser exatamente um dos valores permitidos. Na dúvida usa "outros".
- Se a imagem tiver total e subtotal, usa o TOTAL pago.
- Se não houver data visível, usa hoje: ${hoje()}.
- Se a imagem não for financeira (uma foto qualquer, um print de conversa), devolve encontrou=false e zeros.
- "confianca" é baixa se o valor estiver cortado, ilegível ou se houver mais de um total possível.`;

function extrairJson(resposta) {
  const bloco = resposta.content.find((b) => b.type === "text");
  if (!bloco) return null;
  try { return JSON.parse(bloco.text); } catch { return null; }
}

/**
 * Lê uma imagem (comprovante, print de notificação, cupom) e extrai o lançamento.
 */
async function analisarImagem(base64, mediaType = "image/jpeg") {
  if (!ENABLED) return { erro: "sem_ia" };
  try {
    const resposta = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: {
        effort: "low", // extração curta e bem definida — não precisa de raciocínio profundo
        format: { type: "json_schema", schema: SCHEMA },
      },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: `${INSTRUCOES}\n\nLê esta imagem e extrai o lançamento.` },
        ],
      }],
    });

    if (resposta.stop_reason === "refusal") return { erro: "recusado" };
    const dados = extrairJson(resposta);
    return dados || { erro: "sem_resposta" };
  } catch (err) {
    console.error("IA imagem:", err.message);
    return { erro: "falhou" };
  }
}

/**
 * Interpreta texto que o parser de regras não conseguiu — tipicamente uma
 * notificação de banco encaminhada.
 */
async function analisarTexto(texto) {
  if (!ENABLED) return { erro: "sem_ia" };
  try {
    const resposta = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SCHEMA },
      },
      messages: [{
        role: "user",
        content: `${INSTRUCOES}\n\nEsta é uma mensagem encaminhada, provavelmente de um banco ou app de pagamento. Extrai o lançamento:\n\n"""\n${texto}\n"""`,
      }],
    });

    if (resposta.stop_reason === "refusal") return { erro: "recusado" };
    const dados = extrairJson(resposta);
    return dados || { erro: "sem_resposta" };
  } catch (err) {
    console.error("IA texto:", err.message);
    return { erro: "falhou" };
  }
}

/**
 * Transcreve uma nota de voz. Devolve o texto, para o parser normal tratar.
 */
async function transcreverAudio(base64, mimetype = "audio/ogg") {
  if (!AUDIO_ENABLED) return { erro: "sem_transcricao" };
  try {
    const buffer = Buffer.from(base64, "base64");
    const ext = mimetype.includes("mp4") || mimetype.includes("m4a") ? "m4a"
      : mimetype.includes("mpeg") || mimetype.includes("mp3") ? "mp3"
      : "ogg";

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimetype }), `audio.${ext}`);
    form.append("model", TRANSCRIBE_MODEL);
    form.append("language", "pt");

    const res = await fetch(TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${TRANSCRIBE_KEY}` },
      body: form,
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.error("Transcrição:", res.status, (await res.text()).slice(0, 200));
      return { erro: "falhou" };
    }
    const dados = await res.json();
    const texto = (dados.text || "").trim();
    return texto ? { texto } : { erro: "vazio" };
  } catch (err) {
    console.error("Transcrição:", err.message);
    return { erro: "falhou" };
  }
}

// Heurística barata: vale a pena gastar uma chamada de IA neste texto?
// Notificações de banco têm valor + vocabulário próprio.
const RX_BANCO = /\b(compra|aprovad[ao]|cart[aã]o|final \d{4}|pix|transfer[eê]ncia|d[eé]bito|cr[eé]dito|fatura|lan[çc]amento|estabelecimento|comprovante|recebeu|enviou|pagamento (de|realizado)|nubank|inter|ita[uú]|bradesco|santander|c6|picpay|mercado pago|will bank|neon|banco do brasil|caixa)\b/i;
const RX_VALOR = /R\$\s*\d/i;

const pareceNotificacaoBancaria = (texto) =>
  RX_VALOR.test(texto) && RX_BANCO.test(texto) && texto.length > 25;

module.exports = {
  ENABLED, AUDIO_ENABLED, MODEL,
  analisarImagem, analisarTexto, transcreverAudio, pareceNotificacaoBancaria,
};
