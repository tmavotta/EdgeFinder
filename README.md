# EdgeFinder

A personal project for spotting good bets across sportsbooks. It pulls live odds
from a bunch of sports books, and finds Arbitrage and positive EV oppourtunities.

- **Arbitrage** : a rare situation where the odds across different books
  disagree enough that you could bet on every outcome and come out ahead no
  matter what happens. Essentially the sum of all the implied probabilities of each possible outcome for a bet needs to be less than one. For example if the game you bet on is Raptors vs Lakers, and one sports books puts Raptors at +110 (meaning bet $100 to win $210, implied probability 100/210), and a different sportsbook puts Lakers at +120 (meaning bet $100 to win $220, implied probability 100/210) then there is an arbitrage oppourtunity as 100/210+100/220<1.
- **+EV bets** : bets where the odds a book is offering look better than what
  the market as a whole thinks is fair, based on averaging odds across books.

No money acctually moves through the app, it can only tell you what to bet on. Realisticaly it's not very practical as by the time you log into all the sportsbooks and place the bets, the arbitrage oppurtunity could be gone. Nonetheless, it is an interesting concept, and maybe in the future I'll try and make it possible for it to auto-place bets.

## How it's put together

Two pieces that run separately:

- **Backend** (`main.py`): a Python server that fetches odds from
  [The Odds API](https://the-odds-api.com/), does the arbitrage/EV math, and
  keeps a local history in a SQLite file.
- **Frontend** (`src/`): a dashboard that talks to the backend and shows
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
