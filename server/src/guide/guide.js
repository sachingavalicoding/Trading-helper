import { CONDITIONS, GROUPS } from '../combos/conditions.js';

// The how-to-use guide, as one Markdown text. The indicator dictionary at the end is built from the app's own list of checks,
// so it can never drift from what the app really has.

const BODY = `# Nifty Paper Trader: how to use it

Paper money only. Nothing here places a real order. Not investment advice.

## 1. The screens

| Tab | What it is for |
|---|---|
| Market | Three small tabs: Stocks (your watchlist and today's strip; tap a stock for its chart, order sheet and signal), Scanner (the share ideas and the auto share trader's on/off switch) and News (the morning news calls). |
| Options | Nifty options: the live chart read, the auto trader's on/off switch, open trades, history and the log. |
| Combos | Your combinations, the one place for them: make one, edit its checks, switch it on or off, and tap Results for every entry over 15 days or more with its order settings (test, then save). The other buy triggers (score, patterns, share setups) are folded below. |
| Trades | Four small tabs: Shares (open positions), P&L (charts and tables), Orders and Day review. |
| More | Your money, Settings (every stop, profit lock, hour, limit and safety rule of both bots), Research (test an idea, Learn, saved data and day report), the replay and this guide. |

## 2. A normal day

1. Before 09:15: open the Options tab and check the auto trader is ON, and that Combos (what it buys) and More > Settings (its rules) are what you want.
2. During the day: you can leave it. Entries and exits are automatic.
3. After 15:30: Trades > Day review (every call against what happened), and More > Research > Saved data and day report (copy it to paste in the chat).
4. Once a week: run a study (section 5) and look at what paid and what did not.

## 3. How an options entry happens

1. Every 15 seconds the app reads the Nifty 1-minute candles and builds 5-minute bars.
2. When a 5-minute bar closes, it checks your chart patterns and your combinations (Combos). An entry is acted on only if the bar closed less than 4 minutes ago, and only once per bar.
3. A signal becomes a trade only if the limits allow it:
   - the entry hours (More > Settings) and the trades-a-day cap are not used up
   - the daily loss limit is not reached
   - no call (or put) is already open
   - 20 minutes have passed since a losing trade, and 15 minutes since a trade on the same side closed
   - the stop is not wider than 2.5 ATR and one lot does not lose more than your loss limit at that stop
   - the combination score (if you set a minimum) is high enough
4. It buys one at-the-money contract for the weekly expiry, sized so the stop loses no more than your limit.

## 4. How an options trade ends

- **Chart stop:** when a 1-minute candle of the index CLOSES beyond the stop level. One wick through the level does not count.
- **Profit ladder:** once the profit reaches a row, the stop keeps that row's amount and then follows a fixed gap behind the best profit. A small gap sells on the first dip; a big gap gives back more.
- **Trail and break-even:** optional, in points of the index.
- **Hard stop:** a backup in the order engine for a fast gap.
- **15:15:** everything is closed.

## 5. Studies: what would have happened

A study replays past candles through your rules. It changes nothing live.

**To run the Options study:** More > Research > Test an idea > Score bot and studies.
2. Pick the days. With real prices on, "10d" means the newest 10 days that have saved option prices.
3. Keep "Use the real option prices" on. Without saved prices it falls back to an estimate and says so.
4. Keep "Trade like the live bot" on, so the study obeys the same pauses, one call and one put at a time, the daily cap and the loss limit, and buys one minute after the signal bar.
5. Pick trades a day (3, 5, 10 or your own setting) and the exit time.
6. Press Run study.

**Reading a row:** net after charges, trades, win rate, average win and loss, the older half and the newer half, calls against puts, the hours, and "If a minimum chart score was needed".

- **Keep:** made money on both halves. **Unsteady:** made money on one. **Drop:** lost. **Too few:** under 15 trades, so no verdict.
- **Older and newer half:** a good result on both is worth much more than a big total made on one.
- **Score table:** shows what a minimum chart score (40 to 80) would have done to that row. If 60+ keeps the profit and removes losers, set the Combination score to 60+.
- **Skipped by live rules:** how many signals the pauses, the day cap, the holding rule and the loss limit removed. A study that skips a lot is telling you live will too.

**Do not fool yourself.**
- 17 days is a short time. A combination chosen from 100 tried is partly lucky.
- Paper-test a new combination for about two weeks before trusting it.
- The study fills at candle prices. Real orders fill a little worse.

## 6. Making a combination

Combos > Options (or Shares) > New combination.
1. **Name** it.
2. **Pick checks** (up to 20). Use search or the groups. Each check has a one-line description under its name. The dictionary at the end lists all of them.
3. **Rule:** all together, or at least N of them.
4. **Event window:** a "cross" or a "break" counts for this many bars (1 to 6, default 3).
5. **Index:** Nifty. **Side:** calls and puts, calls only, or puts only. A combination built from bullish checks should usually be calls only: its put twin is the mirror image and can buy puts on a rising day.
6. **Stop and exits:** its own stop, ladder, trail and break-even, or the shared ones.
7. Save. It opens by itself with its results and order settings: check every entry over 15 days or more before you switch it on.

**Good building rules**
- Use one entry check (a break or a cross) plus two or three filters (trend, breadth, time of day).
- Add a filter only if the study shows it removes losers more than winners.
- Do not stack ten checks. Few trades make any result unreliable.

**A trend-day idea to test (not proven):** Open drive + Breaks the opening range + Breadth 70%+ + ADX rising, calls only, entry hours 09:30 to 11:00.

## 7. A combination's results, the Finder and the View button

- **Results (Combos > tap a combination):** one combination over 10, 15 or 30 days: every entry on a chart, day by day, and which extra check would have skipped each loser.
- **Finder (Research > Test an idea > Best indicator, stop and exit):** tries extra checks, pairs and triples, and judges them on older and newer days. Slower. A shortlist, not an answer.
- **View button:** next to a trade in a study or a combination's results. It opens a card that says why the entry happened (which checks held, and what each check means), what the index and the option did, how it ended, and the numbers.

## 8. Score

The chart score is out of 100 for a call and for a put, from about 15 signs (trends, EMAs, VWAP side, ADX, RSI, MACD, key levels, breadth, candle, and so on). A high score means many signs agree. It is not a promise. Patterns and combinations can have a minimum score (Combos); it is off by default.

## 9. Profit and loss and the guide (Trades and More)

- **Trades > P&L:** your result with charts and tables: bars for each day, week or month, a running total, and tables by weekday, hour and symbol, for 7, 30 or 90 days or all. Shares and options are kept apart.
- **App guide:** this file.

## 10. Honest limits

- Studies are not live. The usual gaps: candle fills, late entries, sample size, and many combinations tried.
- SEBI's study of FY25 found about 91% of individual F&O traders lost money (a total of about ₹1.05 lakh crore). Treat any option strategy as unproven until it survives weeks of paper trading.
- A "big move day" cannot be predicted with one indicator. Several signs together (open drive, range break, wide breadth, rising ADX) raise the odds. They do not remove losing days.
- Shares auto trading has done well on paper so far, but with few trades. Keep it on paper until it has weeks of results.
`;

const KIND = { state: 'true now', event: 'just happened' };

/** The dictionary of every check: group, name, what it does, and whether it is a state or an event. */
function dictionary() {
  const lines = ['', '## 11. Dictionary of checks', '', 'A check is a state (it is true now) or an event (something just happened; it counts for the event window). A put uses the same check on the mirrored chart.', ''];
  for (const group of GROUPS) {
    const list = CONDITIONS.filter((c) => c.group === group);
    if (!list.length) continue;
    lines.push(`### ${group}`, '');
    for (const c of list) lines.push(`- **${c.label}** (${KIND[c.kind]}${c.needs ? `, needs ${c.needs === 'flow' ? 'volume of the 50 stocks' : c.needs}` : ''}): ${c.text}`);
    lines.push('');
  }
  return lines.join('\n');
}

export const guideText = () => `${BODY}${dictionary()}\n`;
