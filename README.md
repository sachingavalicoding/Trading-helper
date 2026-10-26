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

Open the app, create an account and you'll have ₹1,00,000 of virtual money.

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
- With market hours enforced, nothing is suggested before 09:30 or after 14:45 IST.

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
- **Today's plan.** From 09:00 IST on each trading day the server builds a watch list and sends one "Morning plan ready" alert. The Scanner tab shows it under "Today's plan" (also at `GET /api/scanner/plan`). A stock is listed when its score reaches 1.5 from: fresh news (up to 3 points either way), yesterday's close in the top or bottom quarter of its range (1 point) and a gap of 0.7% or more at the open (1 point). Each entry names the level to wait for: yesterday's high for a buy, yesterday's low for a sell. It is a watch list, not a signal.

The code is in `server/src/scanner/plan.js` and `client/src/lib/alerts.js`; tests are in `server/test/alerts.test.js`.

## Auto paper trading

Off by default. On the Scanner page, the "Auto paper trading" switch lets the server place **virtual** orders for scanner ideas, using the idea's stop loss and first target. It never contacts a broker. Limits you can change: minimum score (default 70), max open auto trades (3), risk per trade (1%) and a daily loss stop (3%). It skips a stock you already hold. Auto orders are tagged AUTO on the Orders page. It follows the scanner's rules, so it can lose, and the track record is the way to judge it.

## Safety checks and rejected ideas

A score adds up good signs, but a high score can hide one fatal flaw. So every idea must also pass hard checks: volume not thin, right side of VWAP, 5m and 15m trend not against it, Nifty 50 not against it, not stretched from VWAP, RSI not extreme, news not against it. A stock that already stopped out today, or already had 2 ideas today, is skipped. Anything rejected shows under "Not worth entering" with the reasons, and an open idea whose price has already run past the entry says "Do not enter". Each card also shows what past ideas with a similar score really did.

## Limits and filters

On the Scanner page you set a **max amount per trade** (default ₹30,000; shares are sized to stay under it as well as under your risk %), and filter by side, minimum score (70%+, 80%+, 90%+) and time of day. Auto paper trading has its own max amount, and defaults to at most 2 open trades, 0.5% risk per trade and a 2% daily loss stop. Ideas with a stop wider than 1.2% of the price are rejected. The scanner re-checks all 50 stocks every 15 seconds and the page refreshes every 10 seconds. An idea that price has already run away from leaves the main list and is kept under "Not worth entering".

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
