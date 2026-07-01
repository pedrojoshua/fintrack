import os
import re
import requests
from datetime import datetime
from dotenv import load_dotenv
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, filters, ContextTypes

load_dotenv()

TOKEN = os.getenv("TELEGRAM_TOKEN")
API_URL = "http://localhost:5000/api"

CATEGORY_KEYWORDS = {
    "alimentação": ["supermercado", "mercado", "restaurante", "comida", "almoço", "jantar", "café", "padaria", "pizza", "mcdonalds", "ifood", "uber eats", "alimentação", "lanche", "snack"],
    "casa": ["renda", "aluguel", "luz", "água", "gás", "internet", "condomínio", "casa", "móveis", "ikea", "limpeza", "decathlon"],
    "transporte": ["gasolina", "uber", "bolt", "táxi", "metro", "autocarro", "comboio", "combustível", "transporte", "estacionamento", "parking", "portagem"],
    "saúde": ["farmácia", "médico", "dentista", "hospital", "consulta", "medicamento", "saúde", "clínica", "exame"],
    "lazer": ["cinema", "netflix", "spotify", "amazon", "viagem", "hotel", "férias", "lazer", "bar", "discoteca", "jogo", "xbox", "playstation"],
    "investimento": ["investimento", "ações", "bitcoin", "cripto", "etf", "fundo", "poupança", "depot", "trade"],
    "casamento": ["casamento", "wedding", "noivado", "aliança", "vestido", "traje", "lua de mel", "convite", "flores", "venue", "buffet"],
}

def detect_category(text: str) -> str:
    text_lower = text.lower()
    for category, keywords in CATEGORY_KEYWORDS.items():
        for kw in keywords:
            if kw in text_lower:
                return category
    return "outros"

def parse_message(text: str):
    pattern = r"([\d]+(?:[.,]\d{1,2})?)\s*€?\s*(.+)"
    match = re.match(pattern, text.strip())
    if not match:
        return None, None
    amount = float(match.group(1).replace(",", "."))
    description = match.group(2).strip()
    category = detect_category(description)
    return amount, description, category

async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "💰 *FinTrack Bot ativo!*\n\n"
        "Envia uma mensagem no formato:\n"
        "`50 supermercado`\n"
        "`200 casamento`\n"
        "`1000 investimento ETF`\n\n"
        "Comandos:\n"
        "/resumo — ver resumo do mês\n"
        "/ajuda — ver todos os comandos",
        parse_mode="Markdown"
    )

async def ajuda(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "📖 *Como usar:*\n\n"
        "• `valor descrição` — registar gasto\n"
        "  Ex: `35 gasolina`, `120 médico`, `50 netflix`\n\n"
        "• Categorias auto-detectadas:\n"
        "  🛒 Alimentação • 🏠 Casa • 🚗 Transporte\n"
        "  💊 Saúde • 🎮 Lazer • 📈 Investimento • 💍 Casamento\n\n"
        "/resumo — gastos deste mês\n"
        "/casamento — progresso poupança casamento",
        parse_mode="Markdown"
    )

async def resumo(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    try:
        r = requests.get(f"{API_URL}/summary", timeout=5)
        data = r.json()
        now = datetime.now()

        lines = [f"📊 *Resumo {now.strftime('%B %Y')}*\n"]
        lines.append(f"💸 Gastos: *{data['expenses']:.2f}€*")
        lines.append(f"📈 Investimentos: *{data['investments']:.2f}€*")
        lines.append(f"💍 Casamento este mês: *{data['wedding_month']:.2f}€*\n")

        cat_icons = {
            "alimentação": "🛒", "casa": "🏠", "transporte": "🚗",
            "saúde": "💊", "lazer": "🎮", "outros": "📦"
        }
        if data["by_category"]:
            lines.append("*Por categoria:*")
            for cat, val in data["by_category"].items():
                if cat not in ("investimento", "casamento"):
                    icon = cat_icons.get(cat, "•")
                    lines.append(f"  {icon} {cat.capitalize()}: {val:.2f}€")

        budget = data["budget"]
        expenses = data["expenses"]
        pct = (expenses / budget * 100) if budget > 0 else 0
        bar = "█" * int(pct / 10) + "░" * (10 - int(pct / 10))
        lines.append(f"\n💼 Orçamento: [{bar}] {pct:.0f}%")
        lines.append(f"  {expenses:.2f}€ / {budget:.2f}€")

        await update.message.reply_text("\n".join(lines), parse_mode="Markdown")
    except Exception as e:
        await update.message.reply_text("❌ Erro ao conectar ao FinTrack. Confirma que o servidor está a correr.")

async def casamento(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    try:
        r = requests.get(f"{API_URL}/summary", timeout=5)
        data = r.json()
        w = data["wedding"]
        saved = w["saved"]
        goal = w["goal"]
        pct = min((saved / goal * 100), 100) if goal > 0 else 0
        remaining = max(goal - saved, 0)
        filled = int(pct / 5)
        bar = "💍" * filled + "○" * (20 - filled)

        msg = (
            f"💍 *Poupança Casamento*\n\n"
            f"{bar}\n\n"
            f"Guardado: *{saved:.2f}€*\n"
            f"Objetivo: *{goal:.2f}€*\n"
            f"Falta: *{remaining:.2f}€*\n"
            f"Progresso: *{pct:.1f}%*"
        )
        await update.message.reply_text(msg, parse_mode="Markdown")
    except:
        await update.message.reply_text("❌ Erro ao obter dados do casamento.")

async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.strip()
    result = parse_message(text)

    if result[0] is None:
        await update.message.reply_text(
            "❓ Não percebi. Usa o formato:\n`50 supermercado`\nou `/ajuda` para ver exemplos.",
            parse_mode="Markdown"
        )
        return

    amount, description, category = result
    today = datetime.now().strftime("%Y-%m-%d")

    try:
        r = requests.post(f"{API_URL}/transactions", json={
            "date": today,
            "amount": amount,
            "category": category,
            "description": description,
            "source": "telegram"
        }, timeout=5)

        if r.status_code == 201:
            cat_icons = {
                "alimentação": "🛒", "casa": "🏠", "transporte": "🚗",
                "saúde": "💊", "lazer": "🎮", "investimento": "📈",
                "casamento": "💍", "outros": "📦"
            }
            icon = cat_icons.get(category, "✅")
            await update.message.reply_text(
                f"{icon} *Registado!*\n"
                f"💶 {amount:.2f}€ — {description}\n"
                f"📁 {category.capitalize()}",
                parse_mode="Markdown"
            )
        else:
            await update.message.reply_text("❌ Erro ao guardar transação.")
    except Exception as e:
        await update.message.reply_text("❌ Servidor offline. Inicia o FinTrack primeiro.")

def main():
    if not TOKEN:
        print("❌ TELEGRAM_TOKEN não definido no .env")
        return

    app = ApplicationBuilder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("ajuda", ajuda))
    app.add_handler(CommandHandler("resumo", resumo))
    app.add_handler(CommandHandler("casamento", casamento))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    print("🤖 Bot Telegram a correr...")
    app.run_polling()

if __name__ == "__main__":
    main()
