# FinTrack

Gestão financeira pessoal: controlo de gastos, reserva de emergência e
investimentos — com registo por mensagem no WhatsApp.

## O modelo de dinheiro

Cada movimento é de um destes tipos:

| Tipo | O que faz |
|---|---|
| `entrada` | dinheiro que entra no mês |
| `saida` | despesa do mês |
| `aporte` | sai do mês e entra numa conta (poupança, não é despesa) |
| `resgate` | sai de uma conta e volta ao mês |
| `rendimento` | cresce dentro da conta, sem passar pelo mês |

Daí saem as duas contas que interessam:

```
saldo livre do mês = entradas − saídas − aportes + resgates
património         = soma dos saldos das contas
```

As **contas** são de três tipos: `reserva` (emergência), `investimento`
(carteira) e `meta` (objetivos como casamento ou viagem). O saldo nunca é
guardado em coluna — é sempre recalculado a partir dos movimentos, por isso
não pode ficar dessincronizado.

## Registar por WhatsApp

A instância da Evolution API é ligada ao **teu próprio número**. Escreves na
conversa *"Mensagem para mim mesmo"* e o FinTrack regista e responde ali.
Só são aceites mensagens `fromMe` nessa conversa — ninguém de fora consegue
lançar nada na tua conta.

```
50 mercado                      → saída, alimentação
paguei 89,90 netflix            → saída, assinaturas
ontem 45 uber                   → saída, transporte, data de ontem
12/03 350 ipva                  → saída, impostos, 12 de março
recebi 300 pix do pedro         → entrada, pix recebido
guardei 500 na reserva          → aporte na reserva
investi 1000 no tesouro selic   → aporte no Tesouro Selic
resgatei 200 da reserva         → resgate
rendeu 15,40 no tesouro selic   → rendimento
```

Comandos: `/resumo`, `/reserva`, `/investimentos`, `/contas`, `/desfazer`, `/ajuda`.

## Correr localmente

```bash
npm install
cp .env.example .env   # preenche DATABASE_URL e SESSION_SECRET
npm start
```

O schema é criado automaticamente no arranque.

## Estrutura

```
server.js              arranque, webhooks, ficheiros estáticos
src/db.js              ligação ao Postgres e migrações
src/auth.js            bcrypt + tokens HMAC
src/api.js             rotas REST
src/money.js           saldos, resumo, reserva, investimentos
src/parser.js          interpreta mensagens em português livre
src/categories.js      categorias e deteção automática
src/channels/          handler partilhado + WhatsApp + Telegram
public/index.html      interface
```

## Variáveis de ambiente

Ver `.env.example`. `DATABASE_URL` e `SESSION_SECRET` são obrigatórias — a app
não arranca sem elas. Sem `EVOLUTION_URL`/`EVOLUTION_KEY` o WhatsApp fica
desativado; sem `TELEGRAM_TOKEN` o Telegram fica desativado.
