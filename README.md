# Nifty Paper Trader

A paper-trading web app for the Indian stock market: NSE, Nifty 50 stocks, intraday (MIS) only. **It never places real orders.** Broker connections are read-only price feeds, and a test (`server/test/paperonly.test.js`) fails if any code starts calling a broker's order API. Real-money trading is deliberately not built.

> **Paper trading for learning. Not investment advice.**

- **Backend:** Node.js + Express + MongoDB (Mongoose) + Socket.IO, all ES modules
- **Frontend:** React (Vite) + Tailwind CSS v4 + TradingView Lightweight Charts. It's built for phones first, uses dark mode by default and has a light toggle.
- **Market data:** swappable provider adapters. One connects to the **Upstox Market Data Feed V3** for live prices. A **mock feed** works any time and the UI labels it SIMULATED.

---

## Folder structure

```
nifty-paper-trader/
├── docker-compose.yml          # local MongoDB
├── server/
│   ├── .env.example
│   ├── scripts/upstox-token.js # daily Upstox login helper
│   ├── src/
│   │   ├── index.js            # boot: DB -> provider -> order engine -> HTTP + Socket.IO
│   │   ├── app.js              # Express app, security middleware, routes
│   │   ├── config/             # env parsing, Mongo connection
│   │   ├── market/
│   │   │   ├── instruments.js  # Nifty 50 list + index keys
│   │   │   ├── marketHours.js  # NSE 09:15–15:30 IST, square-off 15:15, holidays
│   │   │   ├── MarketDataService.js  # owns the provider, caches latest ticks
│   │   │   └── providers/
│   │   │       ├── BaseProvider.js   # the adapter contract
│   │   │       ├── MockProvider.js   # simulated feed
│   │   │       ├── index.js          # provider registry
│   │   │       └── upstox/           # Upstox V3 websocket + protobuf + history
│   │   ├── models/             # User, Wallet, Order, Position, Trade
│   │   ├── services/
│   │   │   ├── orderEngine.js  # fills, SL/target legs, margin, square-off
│   │   │   ├── charges.js      # brokerage, STT, exchange, SEBI, stamp, GST
│   │   │   ├── walletService.js
│   │   │   └── analytics.js    # dashboard numbers
│   │   ├── routes/             # auth, market, trading
│   │   ├── middleware/         # JWT auth, zod validation, error handler
│   │   └── socket/index.js     # tick relay to browsers
│   └── test/                   # node:test + supertest against a real MongoDB
└── client/
    ├── .env.example
    ├── vite.config.js          # dev proxy to the API
    └── src/
        ├── context/            # Auth, Theme, Market (socket + status)
        ├── lib/                # api client, tick store, ₹ formatting, chart maths
        ├── components/         # Layout, OrderSheet, CandleChart, DepthPanel, …
        └── pages/              # Watchlist, StockDetail, Positions, Orders, Dashboard, Account, Auth
```

---

## Setup

You need **Node.js 20+** and **MongoDB 6+**.

### 1. Start MongoDB

```bash
docker compose up -d          # or use a local mongod / MongoDB Atlas URI
```

### 2. Backend

```bash
cd server
npm install
cp .env.example .env
# Generate a JWT secret and paste it into .env:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm run dev                   # http://localhost:5000
```

With `MARKET_DATA_PROVIDER=mock` (the default), it starts streaming simulated prices straight away.

### 3. Frontend

```bash
cd client
npm install
npm run dev                   # http://localhost:5173
```

Open the app, create an account and you'll have virtual money to trade with: ₹1,00,000 by default, or whatever `STARTING_BALANCE` is set to in `server/.env`.

**On your phone:** Vite listens on your network. Open `http://<your-computer's-LAN-IP>:5173` on a phone connected to the same Wi-Fi. Add your LAN origin to `CLIENT_ORIGIN` in `server/.env` too (comma-separated).

### 4. Tests

```bash
cd server && npm test         # needs MongoDB; uses the nifty_paper_trader_test database
cd client && npm test
```

---

## Switching to live Upstox data

1. Create an app at <https://account.upstox.com/developer/apps>. Set its **Redirect URL** to `http://localhost:5000/upstox/callback`.
2. In `server/.env`, set:
   ```
   MARKET_DATA_PROVIDER=upstox
   UPSTOX_API_KEY=<API key>
   UPSTOX_API_SECRET=<API secret>
   UPSTOX_REDIRECT_URI=http://localhost:5000/upstox/callback
   ```
3. Start the server with `npm run dev`, then open **http://localhost:5000/upstox/login** in your computer's browser and log in to Upstox. The server saves the token into `.env` and restarts with live prices.
   - **Do this every trading morning.** Upstox tokens expire around 03:30 IST.
   - Until you log in, the server stays up and the app shows "Feed offline".
   - Command-line alternative: `npm run upstox:token`.

On startup the server downloads Upstox's public NSE instrument master and maps each Nifty 50 symbol to its `NSE_EQ|ISIN` key. It caches the map in `server/.cache/` for the day. To skip the download, point `UPSTOX_INSTRUMENT_MAP_FILE` at your own JSON map.

With a live provider, `ENFORCE_MARKET_HOURS` defaults to `true`. That means orders are accepted only between 09:15 and 15:30 IST, no new positions open after 15:15, and every MIS position is auto squared off at 15:15. Add NSE's holiday dates to `NSE_HOLIDAYS`.

**GIFT Nifty:** it trades on NSE IX, which Upstox's feed doesn't carry. The header marks it "n/a" instead of inventing a number.

### Adding another broker (Angel One, Fyers, Dhan)

Create `src/market/providers/<broker>/<Broker>Provider.js` that extends `BaseProvider`. It must:
- implement `connect()`, `subscribe(symbols)`, `getHistory(symbol, interval)` and `disconnect()`
- emit `'tick'` events in the normalized shape documented in `BaseProvider.js`

Then register it in `providers/index.js`. Nothing else in the app talks to the broker directly.

---

## How it works, step by step

1. **Market data.** `MarketDataService` owns a single provider connection and keeps the latest tick for each symbol. Every tick goes to two places: the order engine and the Socket.IO relay.
2. **Socket relay.** Browsers authenticate with their JWT and join rooms. `sym:X` carries light ticks for watchlist rows. `depth:X` carries ticks with 5-level depth, used only on the stock page. `indices` carries index ticks, and `user:<id>` carries that user's fills. Ticks are throttled to 4 per second per symbol to save mobile data. Broker API keys never leave the server.
3. **Order engine.**
   - Market orders fill at the live LTP.
   - A limit order that's already marketable fills right away. Otherwise it waits in an in-memory book and gets checked on every tick for its symbol.
   - When an entry with a stop-loss or target fills, the engine creates **SL-M** and **target** exit legs. They're one-cancels-other (OCO) and reduce-only, so they can only close the position, never open or flip one.
   - Each user's actions are processed one at a time, so two fills can never corrupt a balance.
4. **Margin.** MIS uses 5x leverage, so margin = order value ÷ 5 (configurable). Before accepting an order, the engine checks margin plus estimated charges against available funds. Limit orders block their margin while they wait.
5. **Charges.** Every fill books approximate discount-broker intraday charges:
   - brokerage: 0.03%, capped at ₹20 per order
   - STT: 0.025% on the sell side
   - NSE transaction charge: 0.00297%
   - SEBI fee: ₹10 per crore
   - stamp duty: 0.003% on the buy side
   - GST: 18% on brokerage, exchange and SEBI fees

   Update `services/charges.js` when the rates change.
6. **Positions.** Each round trip (flat → position → flat) is one `Position` document. One order can close a long and open a short: the engine splits the fill and the charges between the two.
7. **Dashboard.** Win rate, best/worst trade and profit factor count closed round trips, scored on P&L after charges. The equity curve and daily P&L are built from every execution in the trade book.

### REST API (all under `/api`, JSON, `Authorization: Bearer <token>` unless noted)

| Method | Path | |
|---|---|---|
| GET | `/health`, `/market/status` | public |
| POST | `/auth/register`, `/auth/login` | public, rate limited |
| GET | `/auth/me` | |
| GET | `/market/instruments`, `/market/snapshot`, `/market/quote/:symbol` | |
| GET | `/market/candles/:symbol?interval=1m\|5m\|15m` | |
| GET / POST | `/wallet`, `/wallet/reset` | |
| GET / POST | `/orders`, `/orders` `{symbol, side, orderType, qty, price?, stopLoss?, target?}` | |
| DELETE | `/orders/:id` | cancel a pending order |
| GET | `/positions?status=OPEN\|CLOSED\|ALL&day=YYYY-MM-DD` | |
| POST | `/positions/:symbol/exit`, `/positions/exit-all` | |
| GET | `/trades`, `/dashboard` | |
| GET | `/news/feed?hours=48&limit=150&symbol=&label=` | every headline (market and Nifty 50), each with its stock and source link |
| GET | `/review/day?day=`, `/review/stock/:symbol?day=`, `/review/techniques?days=30` | calls against results, one stock's day, which techniques paid |

---

## Charts

The stock page chart is built for phones first:

- **Toolbar:** one slim row with 1m / 5m / 15m, an indicators button (with a count of what is on) and fullscreen.
- **Indicators:** tap the indicators button to open a bottom sheet and tick Volume, VWAP, EMA 9, EMA 21, SMA 50, Bollinger Bands (20, 2), RSI (14) or MACD (12, 26, 9). RSI and MACD get their own panes. Only Volume is on by default, and your selection is remembered on the device.
- **Zoom and pan:** pinch or scroll the mouse wheel to zoom, drag to pan. Zoom is capped so candles never get too thin or too fat, and the price axis does not stretch by accident. A "jump to latest" button appears when you scroll back in time.
- **Legend:** the top-left corner shows open, high, low and close for the bar under your finger, or for the live bar.
- **No accidental orders:** the Buy and Sell buttons ignore a finger that slides, and ignore taps for a moment after you pan or zoom the chart.
- **Fullscreen:** opens real fullscreen where the browser allows it. On Android it also rotates to landscape. iPhone uses a full-page view instead.

Indicator maths lives in `client/src/lib/indicators.js` and has unit tests.

## Chart signals (Buy / Sell / No trade)

Each stock page has a **Chart signal** card. It reads the 5-minute and 15-minute charts and gives one of three answers: **BUY**, **SELL** or **NO TRADE**.

It runs eight checks, and each one votes bullish, bearish or neutral:

- price against VWAP
- EMA 9 against EMA 21 on 5-minute bars
- EMA 9 against EMA 21 on 15-minute bars
- RSI (14)
- MACD histogram
- a volume spike on the last bar
- buy against sell quantity in the order book
- the Nifty 50 move today

A BUY or SELL needs at least four net votes, and none of the three trend checks may disagree. RSI above 75 (or below 25) means "stretched, wait".

For a BUY or SELL, the card suggests:

- an entry zone
- a stop loss just past the nearest support or resistance (at least 0.3% away)
- a target just before the next level

If reward is less than 1.5 times risk, the answer becomes NO TRADE. Tap **Why?** to see every check, the nearby levels, and what would prove the idea wrong. If you already hold the stock, the card says **Hold** or **Consider exit**.

Every BUY/SELL you are shown is logged and followed. The dashboard's **Signal track record** shows how often signals reached their target before their stop loss. A signal that does neither within two hours is marked expired.

This is a rule-based reading of the chart for learning. It is not investment advice, and no signal is guaranteed to work. News is not part of it yet. The rules live in `server/src/signals/analyze.js` and have tests in `server/test/signals.test.js`.

## Stocks in play (intraday scanner)

The **Scanner** tab checks all 50 Nifty stocks every minute and shows a short ranked list of ideas. Each idea has a setup, an entry zone, a stop loss, two targets, the reward-to-risk ratio and a share quantity.

**Setups**

- **Opening range breakout:** a 5-minute bar closes past the high or low of the first 15 minutes. It becomes **Gap and go** when the stock also gapped that way by 0.7% or more and held the gap.
- **VWAP pullback:** a stock in a trend dips back to VWAP, holds it, and a 5-minute bar confirms the bounce.
- **Level retest:** a swing high or low (or the previous day's high or low) is broken, then retested from the other side and held.

Not included yet: gap fill.

**Status and score**

- Each idea is **Entry now** (trigger fired and price is still in the entry zone), **Watching** (setup forming) or **Missed** (price ran too far to chase).
- Each idea scores out of 100: the setup (30), trend agreement on VWAP and 5m/15m EMAs (20), volume against normal for that time of day (20), strength against Nifty 50 (15), order book (8) and RSI (7). Penalties apply when Nifty 50 moves against the trade or RSI is stretched. Only ideas scoring 70 or more that also pass the safety checks are shown, and a phone alert is sent only when a new entry idea appears (not for watching ideas, closed ideas or the morning plan).
- An idea needs at least 1.5 times reward to risk, or it is dropped. The stop is never tighter than 0.3% of the price.
- With market hours enforced, nothing is suggested before 09:30 or after 14:30 IST.

**Plans do not move.** When an idea goes to Entry now it is saved with its entry, stop and targets, and followed until target 1, the stop loss or two hours pass (or 15:15 IST). There is one idea per stock, setup and side per day. Outcomes are stored in the `ScanIdea` collection and listed under **Done today**.

**Position size.** Pick a risk per trade (0.5%, 1% or 2% of your balance). Each idea shows the quantity that loses about that much if the stop is hit, limited by your free margin. "Buy with stop loss and target 1" opens the order sheet with the quantity, stop loss and target filled in.

On the mock feed prices are random, so the setups mean nothing. The scanner only means something on live data. With Upstox, history for each stock is loaded once and then kept current from the live feed, so it does not hammer the API.

The rules are in `server/src/scanner/` and the tests are in `server/test/scanner.test.js`.

## News (free, no AI)

Headlines for each Nifty 50 stock come from the free Google News RSS feeds, plus two market-wide feeds. The server loads a few stocks per minute (a full pass takes about ten minutes), keeps 3 days of headlines in the `NewsItem` collection, and drops duplicates and loose matches that do not mention the company.

- **Tagging.** Each headline is scored from -3 to +3 by keyword rules (results beat or miss, profit up or down, orders won, brokerage upgrade or downgrade, dividend or buyback, SEBI or legal trouble, management exit, plant fire, policy hits). Headlines that ask a question or say "may" and "could" count for less. The rules are in `server/src/news/tagger.js` and every tag lists its reasons. They are simple, so a tag can be wrong. Gemini or Claude can later replace `tagHeadline` with the same return shape.
- **Does the market agree?** For good or bad news, the price now is compared with the price when the headline came out: moved 0.3% or more the same way is **agrees**, 0.3% or more the other way is **fading** ("sell the news"), anything else is **no reaction yet**.
- **In the scanner.** News that points the same way as an idea and is confirmed by the price adds up to 10 points (5 when the price has not reacted). Good news that is being sold costs 8. News pointing the other way costs 10, or 15 when the price agrees with it.
- **Screens.** Each stock page has a news card, the scanner has a market headlines card, and an idea shows the headline that affected its score.
- **Turn it off** with `NEWS_ENABLED=false` if the server cannot reach the internet. The scanner works without news.

The news code is in `server/src/news/` and its tests are in `server/test/news.test.js`.

## Alerts and the morning plan

- **Alerts.** When the scanner raises a new idea, or an idea reaches target 1, its stop or expiry, every open browser gets a message (a toast in the app). Tap the bell on the Scanner tab to also get a phone or desktop notification while the tab is in the background. Browsers only deliver these while the page is open; real push when the app is closed needs the installable app (a later step).
- **Today's plan.** From 09:00 IST on each trading day the server builds a watch list and sends one "Morning plan ready" alert. The Scanner tab shows it under "Today's plan" (also at `GET /api/scanner/plan`). A stock is listed when its score reaches 1.5 from: fresh news (up to 3 points either way), yesterday's close in the top or bottom quarter of its range (1 point) and a gap of 0.7% or more at the open (1 point). The daily candles add one more: a coiled day (yesterday was an **NR7** or **NR4**, the narrowest high-to-low range of the last 7 or 4 sessions, or an **inside bar**) adds half a point in the direction the stock already leans. A coiled day alone never lists a stock, because it has no direction. These show as small tags on each entry, and they need only about 8 sessions of the daily candles the scanner already loads. Each entry names the level to wait for: yesterday's high for a buy, yesterday's low for a sell. It is a watch list, not a signal. This extra rule is not covered by `npm run backtest` yet, so judge it by how the plan's stocks behave over a few weeks.

The code is in `server/src/scanner/plan.js` and `client/src/lib/alerts.js`; tests are in `server/test/alerts.test.js`.

## Auto paper trading

Off by default. On the Scanner page, the "Auto paper trading" switch lets the server place **virtual** orders for scanner ideas, using the idea's stop loss and first target. It never contacts a broker. Each auto trade is sized from your risk % and max amount per trade. To cap it, set "Max shares per trade" (for example 1); 0 means no cap. Other limits you can change: minimum score (default 70), max open auto trades (3), risk per trade (1%) and a daily loss stop (3%). It skips a stock you already hold. Auto orders are tagged AUTO on the Orders page. It follows the scanner's rules, so it can lose, and the track record is the way to judge it.

## Safety checks and rejected ideas

A score adds up good signs, but a high score can hide one fatal flaw. So every idea must also pass hard checks: volume not thin, right side of VWAP, 5m and 15m trend not against it, Nifty 50 not against it, not stretched from VWAP, RSI not extreme, news not against it. A stock that already stopped out today, or already had 2 ideas today, is skipped. Anything rejected shows under "Not worth entering" with the reasons, and an open idea whose price has already run past the entry says "Do not enter". Each card also shows what past ideas with a similar score really did.

## Limits and filters

On the Scanner page you set a **max amount per trade** (default ₹30,000; shares are sized to stay under it as well as under your risk %), and filter by side, minimum score (70%+, 80%+, 90%+) and time of day. Auto paper trading has its own max amount, and defaults to at most 2 open trades, 0.5% risk per trade and a 2% daily loss stop. If 3 of the last 4 finished ideas were stopped out, the scanner treats the market as choppy and raises no new ideas for 45 minutes. Ideas with a stop wider than 1.2% of the price are rejected. The scanner re-checks all 50 stocks every 15 seconds and the page refreshes every 10 seconds. An idea that price has already run away from leaves the main list and is kept under "Not worth entering".

## Editing stop loss, target and trailing stop

Tap SL / Target on an open position (on the Positions page or the stock's chart page) to add, change or remove its stop loss and target, move the stop to your cost price, or turn on a trailing stop (0.5%, 1% or 2%). A trailing stop follows the price at that distance and only moves towards profit, never back. The Buy and Sell buttons stay at the bottom of the chart page.

## Profit lock

Every new trade starts with a profit lock, in rupees. Defaults: when the open profit reaches ₹1,000 the stop moves to lock in ₹300, and every extra ₹200 of profit lifts the lock by ₹100 (a 50% ratio), so at ₹2,000 profit ₹800 is locked. It never moves back. If the trade has no stop yet, one is created. Change the numbers on the Account page. Profit is before charges. Because it can close a trade on a dip after a spike, it protects gains but can also cut a trade that would have recovered.

## Track record and replay

- **Track record.** The Scanner tab shows how finished ideas ended: how many hit target 1, were stopped or expired, and the average result in **R** (1R is what the idea risked). It is split by setup, hour of the day, side and score band (`GET /api/scanner/stats`). Under 20 finished ideas the screen warns that the numbers are mostly luck.
- **Replay.** `npm run replay -- --days 3 --symbols INFY,TCS` (in `server/`) runs the same scanner rules over recent 1-minute history and prints how each idea would have ended. Use it with live Upstox data; on the mock feed history is random and the result is meaningless. Limits: Upstox serves only a few days of 1-minute history, there is no order book in a replay, and a bar that touches both the stop and the target counts as stopped. Treat it as a sanity check, not proof. Real proof is weeks of live paper results.

The code is in `server/src/scanner/stats.js`, `replay.js` and `server/scripts/replay.js`; tests are in `server/test/track.test.js`.

## Run on an Android phone (Termux)

The server can run on your phone so it works while your laptop is off. It serves the web app too, so there is one address: `http://localhost:5000`. Free, but untested on real phones and Android may stop background apps.

1. Install **Termux from F-Droid** (not the Play Store version).
2. Create a free MongoDB Atlas cluster, add a database user with a strong password, and allow network access from anywhere (your phone's IP changes). Copy the connection string.
3. In Termux:
   ```
   pkg install -y curl
   curl -fsSL https://raw.githubusercontent.com/sachingavalicoding/Trading-helper/master/termux/setup.sh | bash
   nano ~/Trading-helper/server/.env
   ```
   Set `MONGO_URI`, `MARKET_DATA_PROVIDER=upstox` and the `UPSTOX_*` values. Keep `NODE_ENV=development`. The Upstox redirect URL stays `http://localhost:5000/upstox/callback`.
4. Each morning: `bash ~/Trading-helper/termux/start.sh`, then open `http://localhost:5000/upstox/login` once to refresh the Upstox token.
5. In Android settings, turn off battery optimisation for Termux and keep the phone charged and online 9:00-15:30.

On Android Chrome, open the app and choose menu > Add to Home screen to install it like an app.

The web app is prebuilt in `phone-app/`. After changing the client, run `npm run build:phone` in `client/` and commit the result.

## Honest limitations

- Fills are idealized. They happen at LTP with no slippage, no partial fills and no queue position, so real results will be worse.
- Charges are estimates. The rates change with exchange and SEBI circulars.
- The Nifty 50 list changes at each semi-annual rebalance. Check `market/instruments.js` against niftyindices.com.
- The mock feed is random. Its prices, volumes and depth are **not** market data, and the UI says so.
- One server process holds the resting-order book in memory. To run several instances, move the book to a shared store such as Redis.

## Better scoring and backtest

The score (out of 100) now also counts **ADX** trend strength, whether **EMA 9 / 21 / 50** are lined up, and whether the stock's **sector peers** are moving the same way. A stock whose 5-minute ADX is under 15 is moving sideways and simply earns no trend points; nothing is blocked for it. The points for every part are in one place, `WEIGHTS` in `server/src/scanner/evaluate.js`, and the old scoring is kept as `LEGACY_WEIGHTS` for comparison. The sector reading is the average move of the other Nifty 50 stocks in the same sector, so a sector with one stock has none.

`npm run backtest -- --days 10 --holdout 3 --risk 1000 --slippage 0.05` replays the scanner on history with live Upstox data (after logging in). It sizes each trade to risk a fixed rupee amount, adds slippage and charges, and prints win rate, average win and loss, expectancy, profit factor and max drawdown for the old rules against the enhanced rules, once on the tuning period and once on the most recent unseen sessions. The scanner only sees candles up to each moment, so it cannot peek at the future. Replay has no order book or sector data, so it does not show the full effect of the new score. With few trades the numbers are noise, and a high score is never a promise of a win.

The backtest now also replays the **live exits** (the climbing stop with no sale target, 15:15 square-off) next to the old "sell at target 1" result. For the unseen period it prints the result by setup, hour and how trades ended, and a **first-target table**: for each multiple of the risk (0.5R to 3R), the share of ideas that ran that far before touching their stop, and the average result in risk units. The best first target is the multiple with the highest expectancy that still has a decent hit rate. Two switches test ideas on the same days without changing the live rules: `--stop-scale 0.8` (stops 20% tighter) or `1.3` (30% wider), and `--breakeven 0.2` (an extra rung that lifts the stop at +0.2% of the entry price).

## Auto trades have no sale target

An auto share trade is not sold at a target. It has only its stop, and the stop climbs as the profit grows; the trade ends when price falls back to the stop, or at the 15:15 square-off. The climb is in percent of the money put in, so it is the same at any size: at +0.30% the stop keeps 0.15%, at +0.45% it keeps 0.32%, at +0.60% it keeps 0.52%, at +1.00% it keeps 0.90%, and past each rung it follows (profit - kept) behind the best profit. On ₹1 lakh that is +₹300 keeps ₹150, +₹450 keeps ₹320, +₹600 keeps ₹520, +₹1,000 keeps ₹900. The stop only ever moves towards profit. Manual trades are unchanged. Change the rungs on the Scanner tab (Auto paper trading > Change limits > Profit lock ladder), or `lockLadder` on `PUT /api/auto`; an empty list goes back to the built-in ladder.

## Last month, entry quality, and a cap on open ideas

The scanner reads about a month of **daily candles** for every stock (once a day, from Upstox). It adds a "Last month" check to the score (do the last 20+ sessions trend the same way as the trade?), and the month's high and low become levels the setups and targets can use. A stock that has already moved a lot today is **not** blocked just for that: what matters is whether the entry is still close to the trigger, as the scanner already checks. At most 5 ideas are open at once; extras wait under "Not worth entering" until one closes.

## More signals in the score

The 100-point score now also checks: **candle confirmation** (the last 5-minute bar closed strongly in the trade's direction, or is a rejection bar), **Nifty 50 trend and market breadth** (index VWAP and EMA trend, and how many of the 50 stocks are up), **Supertrend**, **on-balance volume**, a **Bollinger squeeze** that is breaking out, and yesterday's **central pivot range**. Yesterday's CPR top and bottom and the R1 and S1 pivots also become levels. All point values are in `WEIGHTS` in `server/src/scanner/evaluate.js` and still total 100. A missing reading earns no points and never blocks an idea.

A setup is **switched off automatically** when its last 20 finished ideas (counted over the last 3 days) averaged worse than -0.25R. It comes back by itself as those results age out. The Scanner page lists such ideas under "Not worth entering" with the reason. Time-of-day weighting is not built yet: it needs more track record first.

## Realistic targets and a 14:30 cut-off

An idea is blocked when target 1 is further away than 80% of the stock's usual daily range (from its last month of daily candles); no daily history means no check. Every idea already needs at least 1.5 times as much reward as risk. New ideas stop at 14:30 IST instead of 14:45, so they have time to work before the 15:15 square-off. In `npm run backtest` the "old rules" keep the 14:45 cut-off and have no reach check.

## Security notes

The app trades paper money only. The real risks are your secrets: keep `.env` (Upstox key, secret and token, Mongo password, `JWT_SECRET`) off GitHub and out of chats, and use a MongoDB user that can reach only this database. The Upstox login pages (`/upstox/login` and `/upstox/callback`) answer only the device running the server, never another phone on the Wi-Fi. Registration is open, so run the server only on a network you trust.
## Auto log

Every decision the auto-trader makes goes into the `autologs` collection: placed or skipped (with the reason), the idea's plan and score breakdown, the price and how far it had run (`movedR`), quantity and order. When a placed trade closes, the row gets the outcome: exit reason (`STOP`, `LOCK` = raised stop hit in profit, `TARGET`, `MANUAL`, `SQUARE_OFF`), P&L after charges, minutes held, result in R, and the best and worst R reached while held. `GET /api/auto/log?day=YYYY-MM-DD` returns the day's rows plus a summary (by exit, setup and score band, skip reasons, and how skipped ideas later ended). The Scanner screen shows it under "Today's auto log". Best and worst R are tracked in memory, so a server restart mid-trade leaves them empty for that trade.

## Add paper money

Account page > "Add paper money" tops up the virtual wallet (`POST /api/wallet/add-funds`, ₹1,000 to ₹1,00,00,000). The starting capital rises by the same amount, so realised P&L does not change. It is a paper balance only: it never touches a broker or real money.

## Locks that survive charges

- A profit lock or target-ladder stop never sits below cost plus 1.5x the round-trip charges, so a "locked profit" is still a gain after charges. If price is not yet far enough above that level, no lock stop is placed.
- Auto trades use the climbing stop sized from the money put in (see "Auto trades have no sale target"). Switch it off per user with `lockByRisk: false` on `PUT /api/auto` to keep only the fixed rupee defaults.
- Auto skips an idea whose profit at target 1 is under 3x its round-trip charges (the skip reason shows in the auto log).

## Slow stocks get smaller targets

If target 1 is further than 0.8 of the stock's usual daily range, the scanner now pulls target 1 (and target 2) in to that reach instead of dropping the idea, as long as the shortened target still pays at least 1.2x the risk. The stop stays where the chart puts it, so a slow stock earns a smaller profit but is not taken at a worse risk. If even the shortened target would not pay 1.2x, the old "Target reachable" check blocks it.

## Nifty options (paper)

A separate **Options** tab, paper money only. It buys Nifty 50 index calls (CE) and puts (PE), never writes (sells) options, and keeps its own positions, orders, trade book, history, dashboard and log: every list takes `?segment=EQ|OPT|ALL` (shares by default, so the share screens never show options).

- **Contracts.** At-the-money, weekly expiry, at least a day left (on expiry day the next week is used). The contract symbol says it all: `NIFTY-20261103-25000-CE`. Lot size is `NIFTY_LOT_SIZE` (default 65, check NSE's current figure; the live feed's own lot size wins when it lists one) and the weekly expiry weekday is `NIFTY_EXPIRY_WEEKDAY` (default 2, Tuesday). The simulated feed prices contracts with Black-Scholes from the simulated Nifty; the Upstox feed lists them through `/v2/option/contract` and streams them like any instrument. **The Upstox contract parsing is written from Upstox's documentation and has not been run against the live API, so check the first morning that the Options tab shows a premium.**
- **Money.** The buyer pays the full premium (no leverage), so risk is capped at what the premium is worth. Charges are options charges: flat brokerage per order, tax on the sell premium, exchange fee and GST (estimates, see `OPTION_RATES` in `charges.js`).
- **The chart read** (`options/signal.js`): the Nifty gets a score out of 100 for a call and for a put from the 5-minute and 15-minute trends, EMA 9/21/50, the day's average price (an index has no volume, so this stands in for VWAP), supertrend, ADX, RSI, MACD, the opening range and previous day levels, breadth of the Nifty 50, the last candle, Heikin-Ashi, stochastic, the pivot range and the choppiness index (four of these are new in `signals/indicators.js`). Hard checks block a trade whatever the score: outside 09:45-14:00, a sideways market (choppiness over 61.8 or ADX under 15), the 15-minute trend against, an extended move (3 ATR beyond the 21 EMA), RSI extremes, a day whose usual range is already used up, no fresh breakout or pullback-and-turn, and no chart level for a stop within 2 ATR.
- **Stop from the chart.** The Nifty level where the idea is wrong (the nearest swing low or high, the supertrend line, the 21 EMA or the day's average, at least 0.8 ATR away, with a small buffer) is repriced into the premium with Black-Scholes, using the contract's own implied volatility. A stop that would cost under 10% of the premium is widened to 10% (inside that it is noise), and one that would cost over 30% means no trade. The trader sells when a 1-minute Nifty candle CLOSES beyond the chart stop (one tick through the level is not enough, so a wick does not shake out a good trade); the premium stop in the order engine stays as the backup for a fast move.
- **Targets that fit the chart.** Target 1 is the nearest level ahead that pays at least 1.2x the premium at risk (capped at 2.5x), pulled in to about ₹1,500 per lot when the level is further; the sale aims at about ₹2,500 per lot (`AIM_FIRST_PER_LOT`, `AIM_SALE_PER_LOT` in `plan.js`). Every target, including the final sale, stays inside what the Nifty can still travel today: 0.8 of its usual daily range less what it has already moved (never under a quarter of the range), repriced into premium. The sale is as far past target 2 as 2 is past 1, but never beyond that reach. Nothing is sold at target 1 or 2: past each, the stop jumps to 80% of the way to it. Trades whose profit at target 1 is under 3x the charges are skipped.
- **Lock ladder in rupees per lot, trail in % of the premium.** Defaults: once a trade is up ₹700 per lot the stop locks ₹400, at ₹1,000 it locks ₹700, at ₹1,500 ₹1,200, at ₹2,500 ₹2,200, and between rungs it follows (profit - kept) behind the best profit (two lots double every number). You can edit the rungs on the Options tab (Change limits > Profit lock ladder), or `lockLadder` on `PUT /api/options`; an empty list goes back to the built-in ladder. It never sits below cost plus 1.5x charges. A trailing stop also follows the best premium at 25% distance (0 turns it off). All settings are on the Options tab (`GET/PUT /api/options`).
- **Size.** Lots are limited by the most one trade may lose (default 7% of the Rs 30,000 set aside), the most lots (2), and the money left. The loss is measured at the Nifty chart stop (what the trade really loses when it sells), not at the wider backup premium stop, but even the backup stop may not lose more than 1.5x that limit.
- **Time.** Everything is closed by 15:00 IST, and a trade that has gone nowhere for 30 minutes is closed (the premium melts every minute). After a losing trade it waits 20 minutes. At most 3 trades a day, one open at a time, and it stops for the day after losing 10% of the set-aside money.
- **Log.** Every trade and every strong setup it turned down is written to `GET /api/options/log?day=` with the reason, the plan, the 15 score checks and how it ended (`STOP`, `LOCK`, `TARGET`, `TIME`, `MANUAL`, `SQUARE_OFF`).
- **By hand.** The Signal tab shows both sides with their scores and reasons and a plan under each side (lots, when it sells, the loss, targets and lock ladder) and a Buy button that places exactly that plan.

About 9 in 10 individual traders lose money in index options. This is a way to test the idea with paper money, not a promise. Real options orders are not built, and real auto orders would need broker and SEBI rules checked first.

## Share risk and charges

- **Risk in rupees.** `riskAmount` on `PUT /api/auto` (default ₹200, 0 = use the % setting) is the most one auto trade may lose if its stop is hit. Shares are sized from it, within the max-amount and margin limits.
- **Reachable targets.** Target 1 and 2 on the idea are pulled in so nothing the plan aims for is further than 0.8 of the stock's usual daily range from the entry. No daily history means no cap. They are shown for planning; the auto trader does not sell at them.
- **Charges filter.** An auto trade is skipped when its round-trip charges would be more than 25% of the money it risks. Charges follow the money traded, so a very tight stop (under about 0.5% of the price) forces a big position whose charges eat the win. It shows in the auto log as a skip with the numbers.

## News gap (earlier entries)

Normal ideas start at 09:30, after the opening range is complete. The **News gap** setup may also start at **09:20**, once the first 5-minute bar has closed. It needs all of these: the stock opened at least 1.5% away from yesterday's close, fresh news that agrees with the direction (and is not being sold), more than half of the gap still held through the first bars, and price breaking the high (or low) of those bars. The stop goes just past where the gap held; targets and the sale follow the usual reach rules. It stays a News gap idea only for the first hour. It must still reach the minimum score and pass every gate, so most mornings it finds nothing.

Nothing trades before 09:15: the NSE pre-open session (09:00-09:15) is an auction that sets the opening price, and the paper engine fills only while the market is open. The 09:00 morning plan already lists gap and news stocks to watch. Switch the setup off for auto trades with `earlyNews: false` on `PUT /api/auto` (a tick box under "Change limits" on the Scanner screen). The backtest has no news, so it cannot test this setup.

## Options bought by hand

The 15:00 cut-off and the 30-minute stall exit apply to the option trader's own trades only. An option you buy by hand (the Buy button on the Options tab) keeps its chart stop, targets, profit ladder, lock and trailing stop, but is not closed by those clock rules; the 15:15 square-off is its only time limit. Before this, a hand-bought option was sold within seconds whenever it was bought after 15:00.

## Look and menu

The app is black with electric blue as the main colour and orange as the highlight. Green and red are kept for up and down only. The light theme is still there (Account, Theme).

The bottom menu has six items: **Stocks, Scanner, Options, News, Trades, Account**. P&L, Orders and Review are buttons on the Account screen (Orders is also a button on Trades).

**Buy buttons switch off when an order cannot be placed.** Outside 09:15-15:15 IST, on weekends and on holidays every Buy and Sell button (stocks, scanner ideas, Options) is greyed out and says why ("Market opens at 09:15", "No new trades after the 15:15 square-off"). It follows the server's own rule, and is off in practice mode (the simulated feed with `ENFORCE_MARKET_HOURS=false`). The check re-runs every 15 seconds, so a button turns off at 15:15 without a reload.

## Stocks grid

The home screen is a sortable grid of all 50 stocks: price, change, where the price sits in today's range (the orange dot), distance from VWAP, gap at the open, volume and a news badge. Tap a header to sort. Filters: gainers, losers, strong (above VWAP and the open, near the day's high), stocks in the news. Tap a row to open the full data (open, prev close, VWAP, gap, volume, news and the way to the chart) and to buy or sell. Rows update live; their order re-sorts every 3 seconds so they do not jump under your finger.

## News tab

Every headline for the Nifty and its 50 stocks, newest first. Each shows the stock (with its live move), a good, bad or neutral tag with the reason, whether the price agrees, and its source, and opens the article when tapped. Filter by good, bad or Nifty, or pick one stock.

## Options chart

The Options tab opens with the Nifty 50 candle chart (1, 5 and 15 minutes, with the usual indicators) and dashed lines at the chart stops a Call (CE) and a Put (PE) would use. Tap the header to fold it away.

## Review: calls against results

`Account, Review` (or the Review button on the News tab). It looks back at what was said and what the price did, for any day:

- **Stocks.** Every stock that had a morning news call (the net tag of headlines out in the 24 hours before the 09:15 open) or a scanner idea. For each: open to close, how far it ran for you (open to high for a buy, open to low for a sell) and the deepest dip against you, and Hit, Miss or Flat (flat = ended within 0.15% of the open). Tap a stock for its 5-minute chart with the headlines, ideas and your trades marked on it, and what each headline was followed by.
- **Options.** The Nifty's day with the chart, what a Call or a Put bought at the open would have seen on the index (best, dip, close), and each option decision you or the auto trader made, with whether the Nifty went that way.
- **Techniques.** Scanner ideas by technique family (Breakout, Trend follow, Level retest, News gap) and by setup, in risk units; which chart checks made a difference (RSI, VWAP, volume ... average result with the check against without it); how stocks followed each kind of news (results, order wins, brokerage calls ...); your own trades by setup and exit in rupees; and ideas by hour. A short list of plain-English takeaways sits on top, and rows with too few samples are left out of them.

Nothing is predicted here: headline tags never change after they are stored and a scanner idea is frozen when raised, so a past day is rebuilt exactly as it was. Daily candles come from the broker, minute candles only for the last few sessions, so older days have no chart. A few days of results are noise; the Techniques tab is meant for a month.

## Day report

The Scanner tab has a **Day report** card. Tap **Copy report** (pick another day with the date field) to copy one text block of the day: the rules in force (including both lock ladders), every scanner idea and how it ended, the auto share trades and option trades with their exits, why trades were skipped, the morning news calls against what the stocks did, and the scanner's track record. Paste it into the chat to review a day. It contains prices, rules and results only. The same text is at `GET /api/report/day?day=2026-10-27`.
