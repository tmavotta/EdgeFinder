# EdgeFinder

A personal project for spotting good bets across sportsbooks. It pulls live odds
for a handful of sports and checks two things:

- **Arbitrage** — a rare situation where the odds across different books
  disagree enough that you could bet on every outcome and come out ahead no
  matter what happens.
- **+EV bets** — bets where the odds a book is offering look better than what
  the market as a whole thinks is fair, based on averaging odds across books.

It's just something I built to poke at this idea, not a product or a service —
no accounts, no money moves through it, it just reads public odds data and
does some math on it.

## How it's put together

Two pieces that run separately:

- **Backend** (`main.py`) — a small Python server that fetches odds from
  [The Odds API](https://the-odds-api.com/), does the arbitrage/EV math, and
  keeps a local history in a SQLite file.
- **Frontend** (`src/`) — a dashboard that talks to the backend and shows
  everything: current opportunities, a threshold slider for +EV bets, and a
  status page showing what's being fetched.

## Running it

You'll need an API key from [The Odds API](https://the-odds-api.com/) (they
have a free tier). Put it in a `.env` file in the project root:

```
ODDS_API_KEY=your_key_here
```

Then start the backend:

```bash
pip install fastapi uvicorn httpx python-dotenv
uvicorn main:app --reload --port 8000
```

And in a separate terminal start the frontend:

```bash
npm install
npm run dev
```

Open the local address it prints and you're in!

## Worth knowing

- Odds API's free tier only gives 500 requests per month, so the app refreshes every 90 secs instead of constantly. You can change this if you would like, there is a variable in `EdgeFinder.jsx` called REFRESH_INTERVAL that controls that.
- This is for learning and curiosity, not betting advice, always check the
  numbers yourself before putting money on anything.
