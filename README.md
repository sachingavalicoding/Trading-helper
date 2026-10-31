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
| GET | `/review/day?day=`, `/review/stock/:symbol?day=`, `/review/patterns?day=`, `/review/techniques?days=30` | calls against results, one stock's day, the chart patterns of a Nifty day with what an option buy would have done, which techniques paid |

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
- With market hours enforced, nothing is suggested before 09:30 or after 15:15 IST (the opening range needs the first 15 minutes; only the news-gap setup can fire from 09:20).

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

Every new trade, auto or by hand, starts with the stop and profit lock you set on the Account page, separately for shares and for options. Defaults: shares stop ₹200 (for auto trades this sets the size; the stop price comes from the chart and must be at least 0.5% from the entry), lock starts at +₹250 and stays ₹80 behind (+₹250 keeps ₹170, +₹400 keeps ₹320); options loss limit ₹1,500 (see the Options section), lock starts at +₹1,000 and stays ₹250 behind (+₹1,000 keeps ₹750, +₹1,500 keeps ₹1,250). For a manual order that has no stop, one is placed that loses that many rupees (an order with its own stop keeps it), and it does not trail. A start of 0 means no lock, a stop of 0 means no automatic stop. The lock never moves back and never sits below cost plus 1.5x the charges. Profit is before charges. `GET/PUT /api/trade-defaults` takes `{ shares: { stopLoss, lockStart, lockGap }, options: {...} }`.

**Typed ladder.** In Account > Limits you type the ladder yourself, as rows (up to 8), for shares and for options: *when the profit reaches ₹X, the stop keeps ₹Y*. Above a row the stop follows that row's gap (X - Y) behind the best profit, and when the profit reaches the next row that row takes over, so `1000 / 750` then `2000 / 1800` keeps 750 from +1,000, 1,000 at +1,250, and 1,800 at +2,000. Both numbers must rise from row to row and the lock must be below its profit. No rows means no profit lock. Saving applies to new trades only; a trade already open keeps the lock it started with (change that one on its own Exits screen). `PUT /api/trade-defaults` also takes `{ shares: { stopLoss, steps: [{ at, keep }] } }`; the first row fills `lockStart` and `lockGap` so older readers see the same lock, and sending `lockStart` or `lockGap` alone goes back to a single row. The Options study and Review > Patterns replay with the same rows.

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

## Upstox request pacing

Candle history (daily, minute and intraday) leaves for Upstox at most 5 requests a second, queued in order, so a restart or a study over the 50 stocks cannot flood the gateway. If Upstox answers HTTP 429 (Cloudflare "Error 1015: You are being rate limited"), all history waits 15 seconds (or the server's `Retry-After`, up to 60 s) and the refused call is sent once more; a second 429 is logged as a failed candle load as before. A block that has already started lasts a few minutes: wait, then reload, and avoid repeated study runs meanwhile. Live prices and orders are not paced.

## Saved candle history

Studies and Review read three months of 1-minute candles (Nifty and the 50 stocks) from your own MongoDB instead of calling Upstox again each time. Charts, option charts, trading and live prices still use Upstox directly.

- **One button:** log in to Upstox, then Research > Data > "Update to now" (or `POST /api/history/sync`, `live` true by default). The first press downloads about 3 months. After that it fetches only the days that are not saved yet **and today so far** (from Upstox's intraday candles, so a study can include today), and then removes the oldest days beyond 3 months. Today is read again on each press and stays marked partial (`CandleCoverage.partial`) until the evening top-up replaces it with the whole day. Days already saved are never fetched again, it resumes where it stopped if it is interrupted or rate limited, and the screen shows how far today is saved. The sample (mock) feed has no history, so the button is refused there.
- **Storage:** one packed, gzipped document per symbol per day (`CandleDay`, about 3 KB) plus a coverage record per symbol (`CandleCoverage`). Roughly 10 MB for 51 symbols. A finished day (after 15:35 IST) is stored whole; today is stored only by the live update.
- **Every evening** after 15:40 IST on weekdays the server adds the new day and deletes anything older than 92 days, but only once a first download exists.
- **During the session:** from 09:20 to 15:40 IST the server refreshes today's candles by itself about every 14 minutes (once a first download exists), and a study over a range that ends today adds the newest minutes from Upstox on top of what is saved, so today is not stuck at the last press of the button. A symbol that could not be saved is listed on the Data screen with the reason.
- **Reading:** a study over N days uses the saved days plus today's live candles. Before anything is saved it falls back to asking Upstox, as before. The Options study offers up to 62 trading days (about 3 months); the Shares study stays at 15 days.

## Options patterns

The Options study and Review > Patterns test these on the Nifty 5-minute chart (a put is the mirror of a call): double bottom/top, sharp fall then turn, breakout of the last hour, opening range breakout (15 and 30 minutes), pullback to the 21 EMA, engulfing, hammer/shooting star, inside bar, supertrend flip, EMA 9/21 cross, 50-stock breadth, break of yesterday's high/low, strong momentum bar, and four that use volume: VWAP reclaim, VWAP pullback, breakout on high volume and volume climax.

The index has no volume of its own, so VWAP and volume are built from the traded value (price times shares) of the 50 stocks. These four are tested only when the 50 stocks' candles are available (in Review, once they are saved) and are not offered to the live trader until a study shows they pay. The win rate and profit of each pattern depend on the days studied: read them in the study, not from this list.

Two "pattern score" rows test agreement: any 2 of Breakout, Engulfing and Strong momentum bar, and all 3, giving the same direction within 15 minutes. Study only; nothing live uses them yet.

## Combinations (Account > Entries)

Pick several checks and the bot buys only when enough of them agree. Code: `server/src/combos/` (`series.js` the indicator maths, `conditions.js` the 117 checks, `combos.js` the engine, `shares.js` the share side, `verdict.js` the Keep/Drop rule), `GET /api/combos/catalog`, and the `combos` list on `OptionSettings` (`PUT /api/options`) and `AutoSettings` (`PUT /api/auto`).

- **The checks.** Over 75 indicators and conditions (trend: EMAs, supertrend, parabolic SAR, ADX/DI, Aroon, Ichimoku, Vortex, regression, day open, yesterday's high; momentum: RSI, MACD, stochastic, CCI, Williams %R, awesome and ultimate oscillators; volatility: Bollinger, Keltner, ATR, 20-bar high, squeeze; volume and VWAP: VWAP, OBV, Chaikin, MFI, force index, heavy volume; candles; the 50-stock breadth; time of day), plus all 19 chart patterns of the study as events, and a news check for shares. Each is written once for a call and the put is the same check on the mirrored chart, so a put cannot drift from its call.
- **State and event.** A *state* is true now (RSI above 50). An *event* just happened (MACD crossed up, a breakout) and counts for a window of bars you choose (default 3). You choose how many must hold: all, or at least N.
- **When it fires.** On the first bar where enough hold, then it waits for them to stop holding (or 3 bars). The stop is the nearest pattern level among the patterns in the combination, else under the last 6 bars.
- **Options.** Tested in the Options study as "My combination: name" next to the patterns, and bought live like a pattern: on a closed 5-minute bar, once per bar, with the same stop limits, lots and daily limits. VWAP, volume and breadth come from the 50 stocks' live candles (the scanner's store), so they work live too.
- **Shares.** A share is read on its own 5-minute bars (its own volume and VWAP, the 50-stock breadth). The Shares study trades each combination on all 50 stocks (one idea per side per stock per day, 09:30 to the exit time) with the same ladder, sizing and charges as the scanner rows. Live, once per 5-minute bar, the auto trader takes a combination idea through the same decision as a scanner idea (stop at least 0.5% and one 5-minute ATR away, size from your Account stop, charges check, open and daily limits); a combination has no score, so the minimum score and the setup switches do not apply to it. News is live only (past headlines are not kept), so a study skips a combination that uses it.
- **Which checks are worth keeping.** Both studies also trade every check on its own (a trade each time it turns true) and mark it **Keep** (made money overall and in both halves of the period), **Unsteady** (won overall, lost in one half), **Drop** (lost) or **Too few** (under 15 trades). The picker hides the checks the last study marked Drop. With over 100 checks a few look good by luck alone, so Keep is a shortlist to try, not proof: run a longer period and watch it live on paper before trusting it.

## Entry triggers and the stop (Account > Entries > Options)

**What triggers a buy** is three separate switches: *Score* (the original all-checks rule), *Chart patterns* (the patterns you pick) and *My combinations* (`comboEntries`, the ones you built). Any mix works, including only one of them. Patterns and combinations are checked first on each closed 5-minute bar, then the score.

**Where the stop goes** is one choice for every trigger, the study and Review (`patternStopMode`, `patternStopAtr`, `patternStopPoints` on `OptionSettings`; `ruleStop` and `stopRuleOf` in `study/patterns.js`):

- **Calculated** (`chart`, the default): the chart level where the idea is proven wrong (for Breakout, under the lowest low of the last 6 bars). The bot skips a trade whose stop is over 2.5 ATR from the entry or whose one-lot loss passes the loss limit.
- **Calculated, capped** (`cap`): the chart level, but pulled in to that many ATRs when it is further, so the trade is taken instead of skipped.
- **ATR** (`atr`): always that many ATRs from the entry.
- **Fixed** (`fixed`): always that many Nifty points from the entry.

For a score entry anything but Calculated moves the stop the score read gave. The Options study trades every row with the chosen rule and also keeps comparison rows with their own rules ("Breakout + Engulfing, stop 1 / 1.5 / 2 ATR from entry", "far stops pulled in to 2 ATR", "fixed stop 20 / 30 / 40 points"), so you can compare them on the same signals before switching. In the 30-day study of 15 Sep to 29 Oct the chart stop beat every stop measured from the entry (+₹20.6k against +₹14.8k for the pulled-in stop and less for the others), because a stop at the chart level is hit less often. Shares keep their own stop.

## Review (Patterns)

For one day Review draws the Nifty chart with each pattern and each of *your combinations* ("Mine" chips, switched on the first time they appear). Tap a signal to see what a one-lot buy would have done under your profit lock and under a fixed booking, **which of the combination's checks held** when it fired, and **what each stop would have done to it** (chart level, 1 / 1.5 / 2 ATR, 20 / 30 / 40 points: how far it is and whether the index went that far against the entry within the hour). *Biggest moves of the day* finds the largest run up and down afterwards and lists the signals near its start, so a missed move is traced to a skipped signal (and why) or to no signal at all. Stops follow your stop setting.

The chart is the same one as on the Options screen: **1m / 5m / 15m**, the full indicator list (volume, VWAP, EMA 9/21/50/200, SMA 50, Supertrend, Keltner, Bollinger, RSI, MACD, CCI, ATR) and fullscreen, with the earlier days drawn to the left so slow indicators are settled at the open. The arrows and the selected trade's lines stay on whichever timeframe you pick. The same chart is used on the Options tab and in a stock's sheet. **The day in words** says what kind of day it was (trend, range or mixed) and lists each big swing with the option side that was right in it; it is found afterwards and is not a live signal.

## Trailing stop, exit research and a simpler Entries screen

- **Trailing stop (options).** Account > Limits > *Options: trailing stop*. Off, or "Follow in points": once Nifty has moved the *start* distance your way, the chart stop sits *points* behind the best Nifty price and never moves back. A call trails up, a put down. The sale is still decided on a closed 1-minute candle beyond the stop, and the profit ladder works alongside it (whichever sells first). The exit is logged as TRAIL. A trade keeps the setting it started with. It is in the live trader (`optionTrader.js`), the Options study and Review (`trailOf` in `study/simulate.js`). Shares keep their climbing percent ladder.
- **Research (Options study > "Also research the stop and profit ladder").** Trades Breakout + Engulfing again and again, changing one thing per row: the most one trade may lose (₹1,000 to ₹3,000), other profit ladders (your own cut to 6 steps, an early, a tight and a wide ladder, no lock, fixed targets) and trailing stops (15 to 50 points, with and without the ladder). Each row shows the older and newer days apart; "Use this" saves the stop amount and ladder in Account > Limits and the trail in the options settings. "Best of each" picks each part on the older two thirds only and only if it beat your settings there, then shows the newest third it never saw. Fixed targets and "no lock" are study-only. Code: `study/research.js`.
- **Limits screen (Account > Limits).** All exit settings are in one place: the most one trade may lose, the **profit lock with an on/off switch** (the rows are kept while it is off), where the first stop goes (calculated, capped, ATR or fixed points, moved here from Entries), the **trailing stop**, and a **break-even stop** (after N points the stop moves to the entry price; exit logged as BREAKEVEN). Break-even and trailing rows are also tried in the Research. The profit lock and the trailing stop work together: whichever sells first wins.
- **Entries screen.** Patterns and your combinations come first, each pattern with its result from your latest study (win rate, net, trades). The score system (options and shares) sits under a fold, "Score (advanced)", and the Options chart read hides its score bars and checks under "Score and checks (advanced)".

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

An auto share trade is not sold at a target. It is sized so the stop loses the Account page's share stop (₹200 by default), and from then on only the profit lock from the Account page (see "Profit lock") moves the stop; the trade ends at its stop or at the 15:15 square-off. The old percent ladder was removed. `npm run backtest` still replays that old ladder, so treat its "live exits" numbers as a rough guide.

## Last month, entry quality, and a cap on open ideas

The scanner reads about a month of **daily candles** for every stock (once a day, from Upstox). It adds a "Last month" check to the score (do the last 20+ sessions trend the same way as the trade?), and the month's high and low become levels the setups and targets can use. A stock that has already moved a lot today is **not** blocked just for that: what matters is whether the entry is still close to the trigger, as the scanner already checks. At most 5 ideas are open at once; extras wait under "Not worth entering" until one closes.

## More signals in the score

The 100-point score now also checks: **candle confirmation** (the last 5-minute bar closed strongly in the trade's direction, or is a rejection bar), **Nifty 50 trend and market breadth** (index VWAP and EMA trend, and how many of the 50 stocks are up), **Supertrend**, **on-balance volume**, a **Bollinger squeeze** that is breaking out, and yesterday's **central pivot range**. Yesterday's CPR top and bottom and the R1 and S1 pivots also become levels. All point values are in `WEIGHTS` in `server/src/scanner/evaluate.js` and still total 100. A missing reading earns no points and never blocks an idea.

A setup is **switched off automatically** when its last 20 finished ideas (counted over the last 3 days) averaged worse than -0.25R. It comes back by itself as those results age out. The Scanner page lists such ideas under "Not worth entering" with the reason. Time-of-day weighting is not built yet: it needs more track record first.

## Realistic targets and the 15:15 cut-off

An idea is blocked when target 1 is further away than 80% of the stock's usual daily range (from its last month of daily candles); no daily history means no check. Every idea already needs at least 1.5 times as much reward as risk. New ideas now run until the 15:15 square-off (they used to stop at 14:30; the reach check already rejects a target too far for the time left). In `npm run backtest` the "old rules" keep the 14:45 cut-off and have no reach check.

## Security notes

The app trades paper money only. The real risks are your secrets: keep `.env` (Upstox key, secret and token, Mongo password, `JWT_SECRET`) off GitHub and out of chats, and use a MongoDB user that can reach only this database. The Upstox login pages (`/upstox/login` and `/upstox/callback`) answer only the device running the server, never another phone on the Wi-Fi. Registration is open, so run the server only on a network you trust.
## Auto log

Every decision the auto-trader makes goes into the `autologs` collection: placed or skipped (with the reason), the idea's plan and score breakdown, the price and how far it had run (`movedR`), quantity and order. When a placed trade closes, the row gets the outcome: exit reason (`STOP`, `LOCK` = raised stop hit in profit, `TARGET`, `MANUAL`, `SQUARE_OFF`), P&L after charges, minutes held, result in R, and the best and worst R reached while held. `GET /api/auto/log?day=YYYY-MM-DD` returns the day's rows plus a summary (by exit, setup and score band, skip reasons, and how skipped ideas later ended). The Scanner screen shows it under "Today's auto log". Best and worst R are tracked in memory, so a server restart mid-trade leaves them empty for that trade.

## Add paper money

Account page > "Add paper money" tops up the virtual wallet (`POST /api/wallet/add-funds`, ₹1,000 to ₹1,00,00,000). The starting capital rises by the same amount, so realised P&L does not change. It is a paper balance only: it never touches a broker or real money.

## Locks that survive charges

- A profit lock or target-ladder stop never sits below cost plus 1.5x the round-trip charges, so a "locked profit" is still a gain after charges. If price is not yet far enough above that level, no lock stop is placed.
- Auto trades use the Account page's stop and lock (see "Profit lock"); there is no separate percent ladder any more.
- Auto skips an idea whose profit at target 1 is under 3x its round-trip charges (the skip reason shows in the auto log).

## Slow stocks get smaller targets

If target 1 is further than 0.8 of the stock's usual daily range, the scanner now pulls target 1 (and target 2) in to that reach instead of dropping the idea, as long as the shortened target still pays at least 1.2x the risk. The stop stays where the chart puts it, so a slow stock earns a smaller profit but is not taken at a worse risk. If even the shortened target would not pay 1.2x, the old "Target reachable" check blocks it.

## Nifty options (paper)

A separate **Options** tab, paper money only. It buys Nifty 50 index calls (CE) and puts (PE), never writes (sells) options, and keeps its own positions, orders, trade book, history, dashboard and log: every list takes `?segment=EQ|OPT|ALL` (shares by default, so the share screens never show options).

- **Contracts.** At-the-money, weekly expiry, at least a day left (on expiry day the next week is used). The contract symbol says it all: `NIFTY-20261103-25000-CE`. Lot size is `NIFTY_LOT_SIZE` (default 65, check NSE's current figure; the live feed's own lot size wins when it lists one) and the weekly expiry weekday is `NIFTY_EXPIRY_WEEKDAY` (default 2, Tuesday). The simulated feed prices contracts with Black-Scholes from the simulated Nifty; the Upstox feed lists them through `/v2/option/contract` and streams them like any instrument. **The Upstox contract parsing is written from Upstox's documentation and has not been run against the live API, so check the first morning that the Options tab shows a premium.**
- **Sensex too.** Options work on the Nifty and the Sensex, one shared budget (default ₹60,000). Sensex is off until you switch it on in Account > Entries > Which index. Symbols look like `SENSEX-20261105-82000-CE`; strike step 100, lot size `SENSEX_LOT_SIZE` (default 20) and weekly expiry weekday `SENSEX_EXPIRY_WEEKDAY` (default 4, Thursday). By default one call and one put at a time across both indexes; *Take the signal on both* (`mirror`, needs max open 2 or more) takes the same signal on each. Score entries are gone for options: entries are patterns and your combinations only (shares keep their score). Studies and Review have a Nifty/Sensex picker; press Download in Research > Data once to get Sensex history. **Untested on the live Upstox API: the Sensex contract call (`BSE_INDEX|SENSEX`), BSE_FO streaming, the lot size, expiry day and BSE charges (Nifty rates are used).**
- **Money.** The buyer pays the full premium (no leverage), so risk is capped at what the premium is worth. Charges are options charges: flat brokerage per order, tax on the sell premium, exchange fee and GST (estimates, see `OPTION_RATES` in `charges.js`).
- **The chart read** (`options/signal.js`): the Nifty gets a score out of 100 for a call and for a put from the 5-minute and 15-minute trends, EMA 9/21/50, the day's average price (an index has no volume, so this stands in for VWAP), supertrend, ADX, RSI, MACD, the opening range and previous day levels, breadth of the Nifty 50, the last candle, Heikin-Ashi, stochastic, the pivot range and the choppiness index (four of these are new in `signals/indicators.js`). Hard checks block a trade whatever the score: outside 09:15-15:15, a sideways market (choppiness over 61.8 or ADX under 15), the 15-minute trend against, an extended move (3 ATR beyond the 21 EMA), RSI extremes, a day whose usual range is already used up, no fresh breakout or pullback-and-turn, and no chart level for a stop within 2 ATR. **Reversal entry:** when the index has fallen (or risen) at least 4 ATR and turned off the extreme (price 1.2 to 2 ATR off the low, a higher low, a bar closing above the previous bar's high, not more than 60% of the move won back), that side gets its own score of 55 plus 9 for each of five confirmations (RSI back from an extreme, breadth, MACD, supertrend, a strong bar), the stop goes just beyond the extreme, and the 15-minute-trend check is waived for it. While it holds, the opposite side is blocked, so the bot does not sell the low. The window is short on purpose: past about 2 ATR off the extreme the stop would risk more than the loss limit.
- **Stop from the chart.** The Nifty level where the idea is wrong (the nearest swing low or high, the supertrend line, the 21 EMA or the day's average, at least 0.8 ATR away, with a small buffer) is repriced into the premium with Black-Scholes, using the contract's own implied volatility. A stop that would cost under 10% of the premium is widened to 10% (inside that it is noise), and one that would cost over 30% means no trade. The trader sells when a 1-minute Nifty candle CLOSES beyond the chart stop (one tick through the level is not enough, so a wick does not shake out a good trade); the premium stop in the order engine stays as the backup for a fast move.
- **Targets that fit the chart.** Target 1 is the nearest level ahead that pays at least 1.2x the premium at risk (capped at 2.5x), pulled in to about ₹1,500 per lot when the level is further; the sale aims at about ₹2,500 per lot (`AIM_FIRST_PER_LOT`, `AIM_SALE_PER_LOT` in `plan.js`). Every target, including the final sale, stays inside what the Nifty can still travel today: 0.8 of its usual daily range less what it has already moved (never under a quarter of the range), repriced into premium. The sale is as far past target 2 as 2 is past 1, but never beyond that reach. Nothing is sold at target 1 or 2: past each, the stop jumps to 80% of the way to it. Trades whose profit at target 1 is under 3x the charges are skipped.
- **Chart stop sized to a loss limit, and the lock from the Account page.** The stop is the Nifty level where the idea is proven wrong (at least 0.8 ATR away), repriced to a premium. The trader sells when a 1-minute Nifty candle closes beyond it, and buys only as many lots as keep the loss at that level within the loss limit on the Account page (default ₹1,500; 0 = no limit); if even one lot is over the limit, or the stop would cost more than 30% of the premium, it skips the trade. A hard premium stop at 1.3 times the limit sits behind it for a fast gap. No targets, no trailing stop, no stall exit. The lock starts at +₹1,000 and stays ₹250 behind the best profit.
- **Size.** Lots are limited by the most one trade may lose (default 7% of the Rs 30,000 set aside), the most lots (2), and the money left. The loss is measured at the Nifty chart stop (what the trade really loses when it sells), not at the wider backup premium stop, but even the backup stop may not lose more than 1.5x that limit.
- **Time.** Everything is closed at the 15:15 IST square-off, and a trade that has gone nowhere for 30 minutes is closed (the premium melts every minute). After a losing trade it waits 20 minutes. At most 3 trades a day, one open at a time, and it stops for the day after losing 10% of the set-aside money.
- **Log.** Every trade and every strong setup it turned down is written to `GET /api/options/log?day=` with the reason, the plan, the 15 score checks and how it ended (`STOP`, `LOCK`, `TARGET`, `TIME`, `MANUAL`, `SQUARE_OFF`).
- **By hand.** The Signal tab shows both sides with their scores and reasons and a plan under each side (lots, the stop and the lock) and a Buy button that places exactly that plan.

About 9 in 10 individual traders lose money in index options. This is a way to test the idea with paper money, not a promise. Real options orders are not built, and real auto orders would need broker and SEBI rules checked first.

## Share risk and charges

- **Risk in rupees.** `riskAmount` on `PUT /api/auto` (default ₹200, 0 = use the % setting) is the most one auto trade may lose if its stop is hit. Shares are sized from it, within the max-amount and margin limits.
- **Reachable targets.** Target 1 and 2 on the idea are pulled in so nothing the plan aims for is further than 0.8 of the stock's usual daily range from the entry. No daily history means no cap. They are shown for planning; the auto trader does not sell at them.
- **Charges filter.** An auto trade is skipped when its round-trip charges would be more than 25% of the money it risks. Charges follow the money traded, so a very tight stop (under about 0.5% of the price) forces a big position whose charges eat the win. It shows in the auto log as a skip with the numbers.

## News gap (earlier entries)

Normal ideas start at 09:30, after the opening range is complete. The **News gap** setup may also start at **09:20**, once the first 5-minute bar has closed. It needs all of these: the stock opened at least 1.5% away from yesterday's close, fresh news that agrees with the direction (and is not being sold), more than half of the gap still held through the first bars, and price breaking the high (or low) of those bars. The stop goes just past where the gap held; targets and the sale follow the usual reach rules. It stays a News gap idea only for the first hour. It must still reach the minimum score and pass every gate, so most mornings it finds nothing.

Nothing trades before 09:15: the NSE pre-open session (09:00-09:15) is an auction that sets the opening price, and the paper engine fills only while the market is open. The 09:00 morning plan already lists gap and news stocks to watch. Switch the setup off for auto trades with `earlyNews: false` on `PUT /api/auto` (a tick box under "Change limits" on the Scanner screen). The backtest has no news, so it cannot test this setup.

## Options bought by hand

The 15:15 close applies to the option trader's own trades only. An option you buy by hand keeps its stop and lock but is not closed by the clock; the 15:15 square-off is its only time limit.

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
- **Patterns.** Pick the chart patterns you want to watch (Breakout and Engulfing are on to start; the choice is remembered on the phone). The Nifty's 5-minute chart for the day shows an arrow where each one formed: up for a call, down for a put, grey where the bot would skip it (stop too far, or a loss above the limit even at one lot). Tap an arrow or a row to see that entry: the stop, how far the index went your way and against you in the next hour, and a one-lot option buy replayed two ways, with your profit lock and with booking a fixed ₹1,000 a lot. The chart draws the entry, the stop, the level where the ₹1,000 would have been booked and where each exit sold. It uses the same detectors and the same replay as the Options study (`server/src/review/patterns.js`), so the Patterns tab and the study agree. Premiums are estimates; the index moves are real. Only the last few sessions have minute candles. Breadth needs the 50 stocks, so it is not drawn.
- **Techniques.** Scanner ideas by technique family (Breakout, Trend follow, Level retest, News gap) and by setup, in risk units; which chart checks made a difference (RSI, VWAP, volume ... average result with the check against without it); how stocks followed each kind of news (results, order wins, brokerage calls ...); your own trades by setup and exit in rupees; and ideas by hour. A short list of plain-English takeaways sits on top, and rows with too few samples are left out of them.

Nothing is predicted here: headline tags never change after they are stored and a scanner idea is frozen when raised, so a past day is rebuilt exactly as it was. Daily candles come from the broker, minute candles only for the last few sessions, so older days have no chart. A few days of results are noise; the Techniques tab is meant for a month.

## Day report

The Scanner tab has a **Day report** card. Tap **Copy report** (pick another day with the date field) to copy one text block of the day: the rules in force (including both lock ladders), every scanner idea and how it ended, the auto share trades and option trades with their exits, why trades were skipped, the morning news calls against what the stocks did, and the scanner's track record. Paste it into the chat to review a day. It contains prices, rules and results only. The same text is at `GET /api/report/day?day=2026-10-27`.


## Setups that are off

Level retest (−0.81R over 47 ideas) and VWAP pullback (−0.47R over 8) are switched off for good in `ALWAYS_OFF` in `server/src/scanner/service.js`, so the scanner no longer raises them as entries. Opening range breakout, Gap and go and News gap still run, and the 20-idea health check can switch those off on its own.

## Options study (Account tab > Reports and studies > Options)

A research window, separate from the live trader: it changes none of its rules. Tap **Run study** (Today, 10, 20 or 30 trading days; Today replays just the current session from Upstox's intraday candles, so you can see what each way of reading the chart would have done on the day you are looking at) and the server reads the Nifty 1-minute candles and the 5-minute candles of the 50 stocks from Upstox (free, a minute or two), then replays each way of reading the chart as paper option trades (lots sized to your Account loss limit, like the live trader): double bottom / top, a sharp fall then a turn, breakout of the last hour, opening range breakout, pullback in a trend, engulfing candle, hammer, inside bar breakout, supertrend flip, EMA 9/21 cross, the 50-stock breadth, "two or more agree", and the **current bot** (the same chart read the live trader uses) for comparison. **Look for new combinations.** Switch this on (15 days or more) and the run also tries each of Breakout, Engulfing and Strong momentum bar with every other check, then with pairs of the ten best checks. Each is learned on the older two thirds of the days and kept only if it also made money on the newer third it never saw, with at least 10 and 5 trades. "Found for you" lists up to eight; **Add** saves one under My combinations **switched off**. With hundreds of tries some are luck, so watch it in Review before switching it on. Free: plain arithmetic on your saved candles, no AI service. (`autoFind` on `POST /api/study/options`.)

**Pair finder** (options and shares studies). Switch on *Also find the best pair* and choose an indicator to start from, or leave it on *The best three on their own* (the three single checks that made money with at least 15 trades). Every other check is tried next to it, each pair is traded on paper and judged twice: on the older two thirds of the days and on the newest third it never saw. Only pairs that made money on both (at least 10 and 5 trades) are shown, five per starting check, with what the partner added over the first indicator alone, calls and puts (buys and sells for shares), and an **Add** button that saves the pair under My combinations *switched off*. Needs 10 trading days or more; free, no AI service. (`pairFind` and `pairFirst` on `POST /api/study/options` and `/shares`; `server/src/study/pairFinder.js`.) With ~100 pairs tried a few will win by luck, so watch an added pair in Review before switching it on.

**Add-on finder and combination finder.** *Start from* in the pair finder also lists your saved combinations (even switched-off ones): it then tries every other check added to that combination (all must hold), judged on older and newer days, and each row says how many of the combination's trades it skips and what it changed against the combination alone, so a check that would have skipped its bad trades shows up. *Also run the combination finder* takes the 12 best single indicators of the run and tries every pair and every group of three (`comboFind` on `POST /api/study/options` and `/shares`; `server/src/study/pairFinder.js`). Both save through Add, switched off.

**Deep finder and per-combination stop.** With the pair finder or the combination finder on, the study runs only the finder (`finderOnly`; no normal study, so it takes longer). The pair finder then also adds the best two and the best three extra checks to each starting point (up to 10 results each), and *Start from* can be *All my combinations that are on* (`combo:*`, up to 6). In the options study each starting point and its top results are researched for the stop and profit settings (`research` on each row: stop amount, ATR, fixed points, ladders, trail, and how far its winners went against it before winning). A combination can carry its own stop (`stopMode`, `stopAtr`, `stopPoints` on `/api/options` combos; set it in the combination editor, or with *Use this* / *Add with its best stop*); the live trader, the studies and Review use it instead of the shared stop for that combination. The profit ladder, trail and break-even stay shared across entries. The shares finder runs without stop research. Results come from past candles and some will be luck: paper-test an added combination for about two weeks.

**Finder tab.** Research > Finder runs only the finders, for options (Nifty or Sensex) or shares: *Improve a combination* (add the best 1, up to 2 or up to 3 checks to one of your combinations, all that are on, or one check), *Find new ones* (the combination finder) or both; results kept per starting point 5, 10 or 20; best means most newer-days profit or highest win rate (`pairGoal`); the days are the last 10 to 62, or a date range between two dates (`from`/`to` on `POST /api/study/options`, at most 65 trading days, read from the saved candles). Only results that beat the starting combination (profit, or win rate for the win-rate goal) and made money on the older and the newer days are shown, and each says which of the combination's entries it skips (how many were losers and what they came to). Options results also get the best stop and profit setting that paid on both parts (`pairResearch`, on by default); a result can be added with its best stop. The *Best found* card and the copied text lead with the best result and its stop and profit setting.

**Review: improve a combination; finder by parts; ladder and stop fixer.** Review > Patterns has *Improve a combination*: pick one of your combinations (even switched off) and every other indicator is tried added to it (all must hold) on that day (`trial=<id>[:key,key]` on `GET /api/review/patterns`); each row says how many of the day's entries it skips (losers and winners, in rupees), how many it keeps and adds, and what it would have saved. Tap up to three to draw the new combination (`NEW` arrows) and see its entries and P/L beside the old one; save it switched off. Review prices trades from the real saved option premiums when the day has them (`real=0` switches to the model); an entry whose contract was not saved shows as skipped. In the Finder, *Try its parts first* (`pairParts`) searches each check of a combination, each pair of a 3+ check one, then the whole, for the best added checks. The per-combination research tries about 18 stop distances and every ladder start (₹1,500 to ₹6,000) with every room behind (₹250 to ₹1,500). Speed: the IST clock parts, expiry instants and each check's per-bar truth (event windows included) are cached, so a finder run takes about a third of the time.

**Pattern score.** Account > Entries > Chart patterns has *Pattern score* (Off, 60+, 70+, 80+; `patternMinScore`): a pattern is bought only while the chart's score for its side, the one on the Options Signal tab, is at least that (the study row "Patterns, score 70+ agrees" shows what it would have paid). Combinations are not score-gated. A pattern is judged once, on its own bar, so one skipped for a low score is not retried on the same bar.

**Review > Patterns shows every indicator.** The page lists all checks (about 80 that the data supports) with how each did on the day: a one-lot buy each time it turned true, with your stop and lock. Tap one to draw it, then tap its arrow for that entry's profit or loss, how far the index went and what each stop would have done. Combinations that are switched off are listed too (marked off). Up to 30 combinations can be saved, each of up to 20 checks.

Code: `server/src/study/` (`patterns.js` the detectors, `simulate.js` one trade and the summary, `optionsStudy.js` the run, `service.js` the background job), API `GET/POST /api/study/options`, the latest result is kept per user in `StudyRun`.

**Exit choice.** The study sells winners one of two ways: your Account **profit lock** (the default, as live), or a **fixed target** you type in (rupees of profit on one lot, default ₹1,000, no profit lock). In both the trade is also sold when a 1-minute candle closes beyond the chart stop, a stop in the same bar as the target counts first (the cautious order), and everything is closed at 15:15. You can also force **1 lot** instead of lots sized to the loss limit; a trade whose loss at the stop would pass the limit is still skipped. This is there to see how much of the result comes from the exit rule. The choice is in the study screen (`exit`, `target`, `fixedLots` on `POST /api/study/options`) and is written in the copied text.

How a trade is replayed: it is bought at the open of the minute after a 5-minute bar closes (09:15 to 15:15), at the nearest strike and the expiry the live trader would pick. The stop is the pattern's chart level on a closed 1-minute candle (never closer than 0.8 ATR; a stop further than 2.5 ATR is skipped and counted), your Account profit lock applies (once the profit reaches the start the stop follows the gap behind the best profit), and it is closed at 15:15. One trade at a time and at most 3 a day per technique. Charges and 0.3% slippage each way are taken off. Lots are sized so the loss at the chart stop stays within the Account loss limit (up to your max lots); a stop that would lose more than the limit even for one lot is skipped and counted, and a hard stop sits at 1.3 times the limit, as live. Extra rows test ideas the live bot does not use: the double bottom with a tighter stop, and the bot with calls only on an up-day (above yesterday's close and the day average). The bot's own trades are also cut by entry type (breakout, pullback, reversal), score band, and calls against puts.

Four rows test "patterns decide, the score confirms": **Patterns alone** (breakout, pullback, engulfing, no score) and the same patterns kept only when the live score for that side was also 60, 70 or 80 or more at that bar close (`patternsWithScore` in `optionsStudy.js`). They change no live rule; they show whether adding the score to the patterns helps before it is built into the trader.

Option prices are **estimated** (Black-Scholes at 14% volatility, there is no history of real premiums), so the rupee amounts are a guide: which technique wins and when is more reliable than the exact rupees. A technique with under 10 trades is marked "too few to trust". The last card asks whether the 50 stocks lead Nifty: the first time each day that 60, 70 or 80% of them sat on one side of yesterday's close, how far Nifty moved the same way over the next 30 and 60 minutes. On the mock feed the history is random, so the screen says its numbers mean nothing.

## Pattern entries (options)

The options trader now has two entry sources, each with a switch under Account > Entries > Options:

- **Chart patterns.** When the 5-minute bar that just closed completes one of the chosen patterns from the Study tab, it buys at once (within 4 minutes of the bar closing, once per bar) with the pattern's own chart stop (never closer than 0.8 ATR; a stop further than 2.5 ATR is skipped and logged). Lots, the hard stop, the profit lock, the 15:15 close, the daily limits and the cooldowns are the same as for every other entry. On by default: **Breakout of the last hour, Inside bar breakout, EMA 9/21 cross**, the three that made money on more than 12 trades in the 30-day study (+₹13.4k, +₹6.4k, +₹2.5k). The others can be switched on one by one; breadth is not offered because the live feed has no history of it. Settings: `patternEntries`, `patterns`, `scoreEntries` in `OptionSettings` (`PUT /api/options`).
- **Score entries.** The original all-checks score. Still on, so nothing is taken away; the 30-day study had it flat (−₹0.3k, calls −₹8.4k, puts +₹8.1k), so switching it off is the choice the study points to. The log row of a pattern entry shows the pattern name as its setup.

Pattern entries are tried first on every scan, so a proven pattern gets the open slot before a score entry.

## Account: reports, studies and entries

The Account tab now holds the things you tune from evidence:

- **Entries.** Options: the chart patterns and the score entries (above). Shares: a switch for each setup the scanner can raise (Opening range breakout, Gap and go, News gap); a switched-off setup still shows in the scanner but the auto trader does not buy it (`skipSetups` in `AutoSettings`, `PUT /api/auto`). Level retest and VWAP pullback stay off for good.
- **Reports and studies.** The **Day report** copy button (moved here from the Scanner tab), the **Options study** and the new **Shares study**. The shares study (`server/src/study/sharesStudy.js`, `GET/POST /api/study/shares`, today or up to 15 trading days) replays the scanner (`scanner/replay.js`, the same code as `npm run backtest`) on the 1-minute candles of the 50 stocks, sized to the share stop in your Account limits, and reports net rupees by setup, side, hour and way of ending, how far ideas run before their stop, and the latest trades. You choose how a trade is sold, as in the Options study: **Profit ladder** (the rows you typed in Account > Limits for shares, with the charges floor the live engine applies) or **Fixed target** (sold when a trade's profit reaches ₹X, no lock, default ₹300), always with the scanner's chart stop and closed at 15:15. Profit is counted in rupees on the shares it would buy for your share stop (`replayStock` with `money`, `scanner/replay.js`). `npm run backtest` still replays the old percent ladder. It takes a few minutes. Every study has a Copy button to paste into the chat.

## Layout: sections you can fold

Long screens are split into sections with a header that says what is inside, so a closed section still gives the picture. Tap a header to open or close it; the choice is remembered on that phone (`Fold` and `useFold` in `client/src/components/ui.jsx`). Account: profile and funds on top (funds details fold away), then a row of tiles: P&L, Orders, Review, and Limits, Entries and Studies. Limits, Entries and Studies open as a popup (a sheet from the bottom on a phone; Escape or a tap outside closes it), and the popup's top line says what is set. Scanner: Today's plan, Weakest and strongest, and Filters and size are folded by default; Entry now, Watching and Done today stay open and Not worth entering is folded. The Stocks tab starts with two tiles for the auto traders (on or off, today's result); tap one to open it.

**Research tab.** The bottom bar now has Research (in place of Scanner, which opens from the Stocks home tiles). It holds Day review (the old Review page, `/review` redirects there), Options and Shares studies, Finder, Data and the day Report, so nothing needs a trip to Account. Account keeps settings only (limits, entries, wallet). No logic changed.
