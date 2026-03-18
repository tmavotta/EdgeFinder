"""
EdgeFinder Backend — FastAPI + SQLite
Run with: uvicorn main:app --reload --port 8000
"""

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import httpx
import sqlite3
import json
import time
import asyncio
from datetime import datetime, timezone
from typing import Optional
from contextlib import asynccontextmanager

# ─── Config ───────────────────────────────────────────────────────────────────

API_KEY = "96e8765708deab40a932e294c9aa3b4f"
ODDS_API_BASE = "https://api.the-odds-api.com/v4"
FETCH_INTERVAL = 90  # seconds between auto-refreshes

SPORTS = [
    "basketball_nba",
    "icehockey_nhl",
    "baseball_mlb",
    "americanfootball_nfl",
    "soccer_epl",
    "soccer_uefa_champs_league",
    "mma_mixed_martial_arts",
    "basketball_ncaab",
]

# ─── Database ─────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect("edgefinder.db")
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sport_key TEXT NOT NULL,
            event_id TEXT NOT NULL,
            home_team TEXT,
            away_team TEXT,
            commence_time TEXT,
            raw_json TEXT NOT NULL,
            fetched_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS arb_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            home_team TEXT,
            away_team TEXT,
            sport_key TEXT,
            profit_pct REAL,
            sum_probs REAL,
            outcomes_json TEXT,
            detected_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS ev_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            home_team TEXT,
            away_team TEXT,
            sport_key TEXT,
            outcome TEXT,
            book TEXT,
            decimal_odds REAL,
            implied_prob REAL,
            true_prob REAL,
            ev_value REAL,
            detected_at TEXT NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS fetch_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sport_key TEXT,
            event_count INTEGER,
            success INTEGER,
            error_msg TEXT,
            requests_remaining INTEGER,
            fetched_at TEXT NOT NULL
        )
    """)

    conn.commit()
    conn.close()

# ─── Analytics ────────────────────────────────────────────────────────────────

def dt_prob(decimal_odds: float) -> float:
    return 1.0 / decimal_odds

def to_american(decimal_odds: float) -> str:
    if decimal_odds >= 2:
        return f"+{round((decimal_odds - 1) * 100)}"
    return str(round(-100 / (decimal_odds - 1)))

def kelly_fraction(true_prob: float, decimal_odds: float, fraction: float = 0.25) -> float:
    """
    Full Kelly = (bp - q) / b  where b = decimal-1, p = true prob, q = 1-p
    We use fractional Kelly (default 25%) to reduce variance.
    """
    b = decimal_odds - 1
    p = true_prob
    q = 1 - p
    full_kelly = (b * p - q) / b
    return max(0.0, full_kelly * fraction)

def compute_arbs(events: list) -> list:
    arbs = []
    for ev in events:
        if not ev.get("bookmakers"):
            continue
        best = {}
        for bk in ev["bookmakers"]:
            mkt = next((m for m in bk.get("markets", []) if m["key"] == "h2h"), None)
            if not mkt:
                continue
            for out in mkt["outcomes"]:
                p = dt_prob(out["price"])
                if out["name"] not in best or p < best[out["name"]]["prob"]:
                    best[out["name"]] = {
                        "name": out["name"],
                        "prob": p,
                        "odds": out["price"],
                        "american": to_american(out["price"]),
                        "book": bk["title"],
                    }

        outcomes = list(best.values())
        if len(outcomes) < 2:
            continue

        sum_probs = sum(o["prob"] for o in outcomes)
        if sum_probs < 0.999:
            profit_pct = (1 / sum_probs - 1) * 100
            # Optimal stakes per $100
            for o in outcomes:
                o["stake"] = round(100 * o["prob"] / sum_probs, 2)
                o["payout"] = round(100 / sum_probs, 2)
                o["implied_pct"] = round(o["prob"] * 100, 2)

            arbs.append({
                "event_id": ev["id"],
                "home": ev["home_team"],
                "away": ev["away_team"],
                "sport": ev.get("sport_title", ev["sport_key"]),
                "sport_key": ev["sport_key"],
                "outcomes": outcomes,
                "sum_probs": round(sum_probs, 6),
                "profit_pct": round(profit_pct, 4),
                "book_count": len(ev["bookmakers"]),
                "commence_time": ev["commence_time"],
            })

    return sorted(arbs, key=lambda x: x["profit_pct"], reverse=True)

def compute_ev(events: list, min_ev: float = 0.01) -> list:
    bets = []
    for ev in events:
        if not ev.get("bookmakers"):
            continue

        # Build consensus true probability (devigged average)
        buckets = {}
        for bk in ev["bookmakers"]:
            mkt = next((m for m in bk.get("markets", []) if m["key"] == "h2h"), None)
            if not mkt:
                continue
            raw = [dt_prob(o["price"]) for o in mkt["outcomes"]]
            total = sum(raw)
            for i, o in enumerate(mkt["outcomes"]):
                buckets.setdefault(o["name"], []).append(raw[i] / total)

        consensus = {k: sum(v) / len(v) for k, v in buckets.items()}

        for bk in ev["bookmakers"]:
            mkt = next((m for m in bk.get("markets", []) if m["key"] == "h2h"), None)
            if not mkt:
                continue
            for out in mkt["outcomes"]:
                ip = dt_prob(out["price"])
                tp = consensus.get(out["name"])
                if not tp:
                    continue
                ev_val = (tp / ip) - 1
                if ev_val >= min_ev:
                    kelly = kelly_fraction(tp, out["price"])
                    bets.append({
                        "id": f"{ev['id']}-{bk['key']}-{out['name']}",
                        "event_id": ev["id"],
                        "home": ev["home_team"],
                        "away": ev["away_team"],
                        "sport": ev.get("sport_title", ev["sport_key"]),
                        "sport_key": ev["sport_key"],
                        "outcome": out["name"],
                        "book": bk["title"],
                        "decimal_odds": out["price"],
                        "american_odds": to_american(out["price"]),
                        "implied_prob": round(ip, 6),
                        "true_prob": round(tp, 6),
                        "edge": round(tp - ip, 6),
                        "ev": round(ev_val, 6),
                        "kelly_pct": round(kelly * 100, 2),
                        "kelly_100": round(kelly * 100, 2),
                        "kelly_1000": round(kelly * 1000, 2),
                        "commence_time": ev["commence_time"],
                    })

    return sorted(bets, key=lambda x: x["ev"], reverse=True)[:100]

# ─── Fetcher ──────────────────────────────────────────────────────────────────

all_events: list = []
last_fetched: Optional[str] = None
requests_remaining: Optional[int] = None

async def fetch_all_odds():
    global all_events, last_fetched, requests_remaining
    events = []
    conn = get_db()

    async with httpx.AsyncClient(timeout=15.0) as client:
        for sport in SPORTS:
            try:
                url = f"{ODDS_API_BASE}/sports/{sport}/odds/"
                params = {
                    "apiKey": API_KEY,
                    "regions": "us,eu,uk",
                    "markets": "h2h",
                    "oddsFormat": "decimal",
                }
                res = await client.get(url, params=params)
                rem = res.headers.get("x-requests-remaining")
                if rem:
                    requests_remaining = int(rem)

                if res.status_code == 200:
                    data = res.json()
                    events.extend(data)

                    # Store snapshot in DB
                    now = datetime.now(timezone.utc).isoformat()
                    for ev in data:
                        conn.execute(
                            """INSERT INTO snapshots 
                               (sport_key, event_id, home_team, away_team, commence_time, raw_json, fetched_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?)""",
                            (sport, ev["id"], ev["home_team"], ev["away_team"],
                             ev["commence_time"], json.dumps(ev), now)
                        )

                    conn.execute(
                        "INSERT INTO fetch_log (sport_key, event_count, success, requests_remaining, fetched_at) VALUES (?,?,?,?,?)",
                        (sport, len(data), 1, requests_remaining, now)
                    )
                else:
                    conn.execute(
                        "INSERT INTO fetch_log (sport_key, event_count, success, error_msg, fetched_at) VALUES (?,?,?,?,?)",
                        (sport, 0, 0, f"HTTP {res.status_code}", datetime.now(timezone.utc).isoformat())
                    )
            except Exception as e:
                conn.execute(
                    "INSERT INTO fetch_log (sport_key, event_count, success, error_msg, fetched_at) VALUES (?,?,?,?,?)",
                    (sport, 0, 0, str(e)[:200], datetime.now(timezone.utc).isoformat())
                )

    # Save detected arbs and EV bets to history
    now = datetime.now(timezone.utc).isoformat()
    arbs = compute_arbs(events)
    ev_bets = compute_ev(events, min_ev=0.02)

    for a in arbs:
        conn.execute(
            """INSERT INTO arb_history 
               (event_id, home_team, away_team, sport_key, profit_pct, sum_probs, outcomes_json, detected_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (a["event_id"], a["home"], a["away"], a["sport_key"],
             a["profit_pct"], a["sum_probs"], json.dumps(a["outcomes"]), now)
        )

    for b in ev_bets:
        conn.execute(
            """INSERT INTO ev_history
               (event_id, home_team, away_team, sport_key, outcome, book, decimal_odds,
                implied_prob, true_prob, ev_value, detected_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (b["event_id"], b["home"], b["away"], b["sport_key"], b["outcome"],
             b["book"], b["decimal_odds"], b["implied_prob"], b["true_prob"], b["ev"], now)
        )

    conn.commit()
    conn.close()

    all_events = events
    last_fetched = datetime.now(timezone.utc).isoformat()
    print(f"[{last_fetched}] Fetched {len(events)} events across {len(SPORTS)} sports")

async def auto_refresh():
    while True:
        await fetch_all_odds()
        await asyncio.sleep(FETCH_INTERVAL)

# ─── App lifecycle ────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    asyncio.create_task(auto_refresh())
    yield

app = FastAPI(title="EdgeFinder API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {
        "name": "EdgeFinder API",
        "version": "1.0.0",
        "events_loaded": len(all_events),
        "last_fetched": last_fetched,
        "requests_remaining": requests_remaining,
        "endpoints": ["/arbs", "/ev", "/events", "/history/arbs", "/history/ev", "/stats", "/refresh"]
    }

@app.get("/arbs")
def get_arbs(sport: Optional[str] = None):
    events = [e for e in all_events if not sport or e["sport_key"] == sport]
    arbs = compute_arbs(events)
    return {
        "count": len(arbs),
        "last_fetched": last_fetched,
        "opportunities": arbs,
    }

@app.get("/ev")
def get_ev(
    sport: Optional[str] = None,
    min_ev: float = Query(default=0.01, ge=0, le=1),
    limit: int = Query(default=50, le=200)
):
    events = [e for e in all_events if not sport or e["sport_key"] == sport]
    bets = compute_ev(events, min_ev=min_ev)
    return {
        "count": len(bets[:limit]),
        "last_fetched": last_fetched,
        "min_ev": min_ev,
        "bets": bets[:limit],
    }

@app.get("/events")
def get_events(sport: Optional[str] = None):
    events = [e for e in all_events if not sport or e["sport_key"] == sport]
    return {
        "count": len(events),
        "last_fetched": last_fetched,
        "events": events,
    }

@app.get("/history/arbs")
def get_arb_history(limit: int = Query(default=100, le=500)):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM arb_history ORDER BY detected_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d["outcomes"] = json.loads(d["outcomes_json"])
        del d["outcomes_json"]
        result.append(d)
    return {"count": len(result), "history": result}

@app.get("/history/ev")
def get_ev_history(limit: int = Query(default=200, le=1000)):
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM ev_history ORDER BY detected_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return {"count": len(rows), "history": [dict(r) for r in rows]}

@app.get("/stats")
def get_stats():
    conn = get_db()
    total_arbs = conn.execute("SELECT COUNT(*) FROM arb_history").fetchone()[0]
    best_arb = conn.execute("SELECT MAX(profit_pct) FROM arb_history").fetchone()[0]
    avg_arb = conn.execute("SELECT AVG(profit_pct) FROM arb_history").fetchone()[0]
    total_ev = conn.execute("SELECT COUNT(*) FROM ev_history").fetchone()[0]
    best_ev = conn.execute("SELECT MAX(ev_value) FROM ev_history").fetchone()[0]
    sport_counts = conn.execute(
        "SELECT sport_key, COUNT(*) as cnt FROM snapshots GROUP BY sport_key ORDER BY cnt DESC"
    ).fetchall()
    book_counts = conn.execute(
        "SELECT book, COUNT(*) as cnt FROM ev_history GROUP BY book ORDER BY cnt DESC LIMIT 10"
    ).fetchall()
    daily_arbs = conn.execute(
        """SELECT DATE(detected_at) as day, COUNT(*) as cnt, AVG(profit_pct) as avg_profit
           FROM arb_history GROUP BY day ORDER BY day DESC LIMIT 30"""
    ).fetchall()
    conn.close()
    return {
        "arbitrage": {
            "total_detected": total_arbs,
            "best_profit_pct": round(best_arb, 4) if best_arb else None,
            "avg_profit_pct": round(avg_arb, 4) if avg_arb else None,
        },
        "expected_value": {
            "total_detected": total_ev,
            "best_ev_pct": round(best_ev * 100, 4) if best_ev else None,
        },
        "by_sport": [dict(r) for r in sport_counts],
        "top_books": [dict(r) for r in book_counts],
        "daily_arbs": [dict(r) for r in daily_arbs],
        "requests_remaining": requests_remaining,
        "last_fetched": last_fetched,
    }

@app.post("/refresh")
async def manual_refresh():
    asyncio.create_task(fetch_all_odds())
    return {"status": "refresh triggered"}
