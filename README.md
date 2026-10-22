# Nifty Paper Trader

A paper-trading web app for the Indian stock market: NSE, Nifty 50 stocks, intraday (MIS) only. It never places real orders.

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

## Honest limitations

- Fills are idealized. They happen at LTP with no slippage, no partial fills and no queue position, so real results will be worse.
- Charges are estimates. The rates change with exchange and SEBI circulars.
- The Nifty 50 list changes at each semi-annual rebalance. Check `market/instruments.js` against niftyindices.com.
- The mock feed is random. Its prices, volumes and depth are **not** market data, and the UI says so.
- One server process holds the resting-order book in memory. To run several instances, move the book to a shared store such as Redis.
