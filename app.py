from flask import Flask, render_template, request, jsonify
from datetime import datetime
import os
from dotenv import load_dotenv
import database as db

load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "fintrack-dev-key")

db.init_db()

CATEGORIES = [
    "alimentação", "casa", "transporte", "saúde",
    "lazer", "investimento", "casamento", "outros"
]

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/transactions", methods=["GET"])
def list_transactions():
    month = request.args.get("month", type=int)
    year = request.args.get("year", type=int)
    now = datetime.now()
    txs = db.get_transactions(month or now.month, year or now.year)
    return jsonify(txs)

@app.route("/api/transactions", methods=["POST"])
def create_transaction():
    data = request.json
    required = ["date", "amount", "category"]
    if not all(k in data for k in required):
        return jsonify({"error": "Campos obrigatórios: date, amount, category"}), 400
    db.add_transaction(
        date=data["date"],
        amount=float(data["amount"]),
        category=data["category"].lower(),
        description=data.get("description", ""),
        source=data.get("source", "manual")
    )
    return jsonify({"ok": True}), 201

@app.route("/api/transactions/<int:tid>", methods=["DELETE"])
def remove_transaction(tid):
    db.delete_transaction(tid)
    return jsonify({"ok": True})

@app.route("/api/summary")
def summary():
    now = datetime.now()
    month = request.args.get("month", now.month, type=int)
    year = request.args.get("year", now.year, type=int)

    by_cat = db.get_monthly_summary(year, month)
    wedding = db.get_wedding_savings()
    monthly_budget = float(db.get_setting("monthly_budget") or 2000)
    trend = db.get_monthly_totals_last_6()

    total_expenses = sum(v for k, v in by_cat.items() if k not in ("investimento", "casamento"))
    total_invest = by_cat.get("investimento", 0)
    wedding_this_month = by_cat.get("casamento", 0)

    return jsonify({
        "expenses": total_expenses,
        "investments": total_invest,
        "wedding_month": wedding_this_month,
        "wedding": wedding,
        "budget": monthly_budget,
        "by_category": by_cat,
        "trend": trend
    })

@app.route("/api/settings", methods=["GET"])
def get_settings():
    return jsonify({
        "wedding_goal": db.get_setting("wedding_goal"),
        "monthly_budget": db.get_setting("monthly_budget")
    })

@app.route("/api/settings", methods=["POST"])
def update_settings():
    data = request.json
    for key in ("wedding_goal", "monthly_budget"):
        if key in data:
            db.set_setting(key, data[key])
    return jsonify({"ok": True})

@app.route("/api/categories")
def categories():
    return jsonify(CATEGORIES)

if __name__ == "__main__":
    print("🚀 FinTrack a correr em http://localhost:5000")
    app.run(debug=True, port=5000)
