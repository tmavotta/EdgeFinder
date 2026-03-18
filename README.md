# ⚡ EdgeFinder — Real-Time Sports Betting Market Analysis Engine

A full-stack application that continuously ingests live odds from multiple sportsbooks, normalises them into implied probabilities, and applies quantitative models to identify market inefficiencies in real time.

![Stack](https://img.shields.io/badge/Frontend-React%20%2B%20Vite-61DAFB?style=flat-square)
![Stack](https://img.shields.io/badge/Backend-Python%20%2F%20FastAPI-009688?style=flat-square)
![Stack](https://img.shields.io/badge/Database-SQLite-003B57?style=flat-square)
![Stack](https://img.shields.io/badge/Data-The%20Odds%20API-FF6B35?style=flat-square)

---

## Overview

Sports betting markets are one of the most data-rich, fast-moving financial environments accessible to the public. Across dozens of sportsbooks, prices (odds) on the same event differ slightly — and those differences encode information. This project builds an engine that reads those differences, converts them into a unified probabilistic framework, and surfaces two categories of opportunity:

- **Arbitrage** — a set of bets across different books that guarantees profit regardless of outcome
- **Positive Expected Value (+EV)** — individual bets where the true probability of winning exceeds what the book's odds imply

The system runs continuously, stores all detections historically, and presents findings in a mobile-first dashboard that updates in near real time.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Frontend (React)                    │
│  Arbitrage Tab │ +EV Tab │ Charts Tab │ Markets Tab      │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTP (every 90s)
┌───────────────────────▼─────────────────────────────────┐
│                   Backend (FastAPI)                      │
│  /arbs  │  /ev  │  /events  │  /stats  │  /history      │
└───────────────────────┬─────────────────────────────────┘
          ┌─────────────┴──────────────┐
          │                            │
┌─────────▼────────┐        ┌──────────▼────────┐
│  The Odds API    │        │   SQLite Database  │
│  8 sports        │        │   Historical arbs  │
│  US/EU/UK odds   │        │   EV detections    │
└──────────────────┘        └───────────────────┘
```

The backend fetches odds independently of the frontend on a configurable interval, meaning the analysis engine runs 24/7 on a server while the frontend is purely a display layer.

---

## The Mathematics

### 1. Implied Probability

Every decimal odd `d` offered by a sportsbook implies a probability:

```
P_implied = 1 / d
```

Sportsbooks build in a margin (the "vig" or "juice") by pricing odds so that the sum of all implied probabilities exceeds 1. For example, a fair coin-flip would be priced at 2.0/2.0 (50%/50%), but books price it at 1.91/1.91 (52.4%/52.4%), giving a 4.8% margin.

### 2. Arbitrage Detection

An arbitrage opportunity exists when the best available odds across all books — one per outcome — produce implied probabilities that sum to less than 1:

```
∑ P_i < 1   →   arbitrage exists
profit % = (1 / ∑P_i − 1) × 100
```

When found, optimal stakes are distributed proportionally:

```
Stake_i = Total × (P_i / ∑P_j)
```

This guarantees an equal payout regardless of which outcome occurs.

### 3. Devigging — Estimating True Probability

To find +EV bets, we need a "true" probability baseline unaffected by the book's margin. The system deviggs each book's odds by normalising their implied probabilities to sum to 1:

```
P_true_i = P_implied_i / ∑P_implied_j
```

The consensus true probability for each outcome is then the average devigged probability across all books in the sample:

```
P_consensus = mean(P_true across all books)
```

### 4. Expected Value

With a consensus probability and a specific book's offered odds:

```
EV = (P_consensus / P_implied) − 1
```

A positive EV means the bet returns more than it costs in expectation. For example, EV = 0.04 means for every $100 wagered, you expect to profit $4 long-run.

### 5. Kelly Criterion — Optimal Bet Sizing

The Kelly Criterion gives the mathematically optimal fraction of a bankroll to wager to maximise long-run growth:

```
f* = (b×p − q) / b
```

Where:
- `b` = decimal odds − 1 (net profit per unit staked)
- `p` = true probability of winning
- `q` = 1 − p (probability of losing)

A full Kelly bet maximises expected log-wealth but has high variance. EdgeFinder applies **fractional Kelly (25%)** to reduce the risk of ruin while preserving the growth advantage:

```
f_fractional = f* × 0.25
```

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Frontend | React 18 + Vite | Component UI, state management |
| Charts | Recharts | EV distribution, scatter plots, bar charts |
| Backend | Python 3 + FastAPI | REST API, async data fetching |
| HTTP Client | HTTPX | Async requests to odds provider |
| Database | SQLite | Historical storage of detections |
| Data Source | The Odds API | Live odds from 40+ sportsbooks |
| Styling | CSS-in-JS | Mobile-first responsive design |

---

## Features

- **Live odds ingestion** across 8 sports (NBA, NHL, MLB, NFL, EPL, UCL, MMA, NCAAB)
- **Multi-region aggregation** — US, EU, and UK books compared simultaneously
- **Arbitrage detector** with stake calculator — tap any opportunity for exact bet distribution
- **+EV scanner** with adjustable threshold slider
- **Kelly Criterion stake sizing** — shows recommended wager for $100, $1k, and $5k bankrolls
- **Historical database** — every detected opportunity stored with timestamp for trend analysis
- **Analytics dashboard** — EV distribution histogram, best books by opportunity count, implied vs true probability scatter plot
- **Real-time refresh** — auto-updates every 90 seconds, manual refresh available
- **Sport and team filtering** — drill down to specific markets

---

## Getting Started

### Prerequisites
- Node.js 18+
- Python 3.10+
- An API key from [the-odds-api.com](https://the-odds-api.com)

### Frontend

```bash
git clone https://github.com/tmavotta/EdgeFinder
cd edgefinder
npm install
```

Create a `.env` file in the root:
```
VITE_ODDS_API_KEY=your_api_key_here
```

```bash
npm run dev
```

### Backend

```bash
pip install fastapi uvicorn httpx
uvicorn main:app --reload --port 8000
```

The backend auto-starts its ingestion loop on startup and begins storing data immediately.

Then in `src/EdgeFinder.jsx` set:
```js
const USE_BACKEND = true;
```

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /arbs` | Current arbitrage opportunities |
| `GET /ev?min_ev=0.02` | +EV bets above threshold |
| `GET /events` | Raw market data for all events |
| `GET /history/arbs` | All historically detected arbitrages |
| `GET /history/ev` | All historically detected +EV bets |
| `GET /stats` | Aggregate statistics and summaries |
| `POST /refresh` | Trigger a manual data fetch |

---

## Project Structure

```
edgefinder/
├── src/
│   ├── EdgeFinder.jsx    # Main React application
│   └── main.jsx          # Entry point
├── main.py               # FastAPI backend + analytics engine
├── edgefinder.db         # SQLite database (auto-created, gitignored)
├── requirements.txt      # Python dependencies
├── .env                  # API keys (gitignored)
└── README.md
```

---

## Limitations & Future Work

- **True arbs are rare** — books monitor each other and close gaps within minutes. The +EV tab surfaces more consistent opportunities
- **API quota** — the free tier of The Odds API allows 500 requests/month. A production deployment would use a paid plan with server-side caching
- **No live in-play odds** — currently limited to pre-match markets
- **Potential extensions** — backtesting engine using historical DB, ML-based probability estimation, spread and totals markets, automated alerting via SMS/email

---

## Disclaimer

This project is built for educational purposes to demonstrate skills in real-time systems design, probabilistic modelling, REST API development, and full-stack engineering. It is not financial advice. Always verify opportunities independently before placing any bets.
