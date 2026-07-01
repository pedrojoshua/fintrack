import sqlite3
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent / "fintrack.db"

def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                amount REAL NOT NULL,
                category TEXT NOT NULL,
                description TEXT,
                source TEXT DEFAULT 'manual',
                created_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            INSERT OR IGNORE INTO settings (key, value) VALUES ('wedding_goal', '15000');
            INSERT OR IGNORE INTO settings (key, value) VALUES ('monthly_budget', '2000');
        """)

def add_transaction(date, amount, category, description="", source="manual"):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO transactions (date, amount, category, description, source) VALUES (?,?,?,?,?)",
            (date, amount, category, description, source)
        )

def get_transactions(month=None, year=None):
    with get_conn() as conn:
        if month and year:
            rows = conn.execute(
                "SELECT * FROM transactions WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ? ORDER BY date DESC",
                (str(year), f"{month:02d}")
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM transactions ORDER BY date DESC LIMIT 100").fetchall()
        return [dict(r) for r in rows]

def get_monthly_summary(year, month):
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT category, SUM(amount) as total
            FROM transactions
            WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ?
            GROUP BY category
        """, (str(year), f"{month:02d}")).fetchall()
        return {r["category"]: r["total"] for r in rows}

def get_wedding_savings():
    with get_conn() as conn:
        row = conn.execute(
            "SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE category = 'casamento'"
        ).fetchone()
        goal = conn.execute("SELECT value FROM settings WHERE key = 'wedding_goal'").fetchone()
        return {
            "saved": row["total"],
            "goal": float(goal["value"]) if goal else 15000
        }

def get_setting(key):
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

def set_setting(key, value):
    with get_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", (key, str(value)))

def delete_transaction(tid):
    with get_conn() as conn:
        conn.execute("DELETE FROM transactions WHERE id = ?", (tid,))

def get_monthly_totals_last_6():
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT strftime('%Y-%m', date) as month, SUM(amount) as total
            FROM transactions
            WHERE category != 'casamento' AND category != 'investimento'
            GROUP BY month
            ORDER BY month DESC
            LIMIT 6
        """).fetchall()
        return [dict(r) for r in reversed(rows)]
