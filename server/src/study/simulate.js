import { bsPrice, impliedVol } from '../options/pricing.js';
import { atmStrike, chooseExpiry, weeklyExpiries, yearsToExpiry, DEFAULT_LOT_SIZE, DEFAULT_EXPIRY_WEEKDAY, STRIKE_STEP } from '../options/symbols.js';
import { calculateCharges } from '../services/charges.js';
import { istParts } from '../market/marketHours.js';
import { round2 } from '../utils/money.js';
import { chaseRise, candlesBefore, chaseSkip } from '../options/chase.js';
import { allot, stopAfter } from '../combos/bot.js';

// Replays one option buy on the Nifty 1-minute chart. There is no history of real option prices, so the premium is estimated
// with Black-Scholes at a fixed volatility. Direction and timing are real; the rupee amounts are an estimate.
//
// Exits follow the live options trader: sell when a 1-minute candle closes beyond the chart stop, once the profit reaches the
// lock start the stop follows `lockGap` behind the best profit, and everything is closed at the 15:15 square-off.
// With a `target` (rupees per lot) there is no profit lock: the trade is sold the moment its profit reaches the target, or at the stop.

export const EXIT_MIN = 15 * 60 + 15; // the 15:15 square-off, as live
export const HARD_STOP_MULT = 1; // the live trader's premium stop: the loss limit itself, charges included (it was 1.3 times the limit)
/** The trailing stop a user's settings ask for, as the simulation and the live trader read it, or null when it is off. */
export function trailOf(settings) {
  if (settings?.trailMode !== 'points') return null;
  const points = settings.trailPoints ?? 25;
  return { points, start: settings.trailStart ?? points };
}

/** Points after which the stop moves to the entry price (break-even), or 0 when it is off. */
export const breakEvenOf = (settings) => Number(settings?.breakEvenPoints) > 0 ? Number(settings.breakEvenPoints) : 0;

const roundTrip = (qty, price) => calculateCharges({ side: 'BUY', qty, price, segment: 'OPT' }).total + calculateCharges({ side: 'SELL', qty, price, segment: 'OPT' }).total;

export const STOP_OFF_FLOOR = 0.5; // as live: with the stop off, a trade is still sold once it has lost half the premium paid

export const SLIPPAGE = 0.003; // 0.3% of the premium lost each way: the spread you cross buying and selling at the market

/**
 * @param c1      Nifty 1-minute bars, oldest first
 * @param byTime  Map of bar time -> index in c1
 * @param signal  { side: 'CE'|'PE', time (entry minute, epoch s), stop (Nifty level) }
 * @param params  { exitMin (minutes after midnight IST when everything is closed, default 15:15), iv, lockStart, lockGap, steps (the typed ladder: [{ at, keep }], overrides lockStart and lockGap), lotSize, holidays, expiryWeekday, strikeStep, lossLimit, maxLots }
 *                `breakEven` (points, 0 = off) moves the stop to the entry price once the index has gone that far your way (exit reason BREAKEVEN).
 *                `trail` ({ points, start }) adds a trailing stop: once the index has moved `start` points your way the chart stop sits `points` behind the best price and never moves back (exit reason TRAIL).
 *                `chase` ({ pct, minutes }) skips a buy whose real premium is already more than `pct` percent above its low of the last `minutes` minutes ({ skipped: 'chase' }).
 *                `cut` (rupees, 0 = off; a combination's own exits.cut) sells the trade once it is that much down (exit reason CUT).
 *                `target` (rupees per lot, 0 = use the profit lock) and `fixedLots` (0 = size the lots to the loss limit) are for studying other exits.
 *                With a `lossLimit` (the Account stop) the lots are sized like the live trader: as many as keep the loss at the chart stop within
 *                the limit, up to `maxLots`, none when even one lot loses more. A hard stop sits at HARD_STOP_MULT times the limit. Without one, 1 lot.
 */
export function simulateTrade({ c1, byTime, signal, params }) {
  // a combination's own exits (ladder, trail, break-even) replace the shared ones for its trades; the no-stop test replaces them all
  const merged = signal.exits ? { ...params, ...signal.exits } : params;
  const noStop = params.noStop ?? null; // { at, keep } (at 0 = no lock): no stop loss, no trail, no break-even, only this lock and the floor
  const { prices: given = null, mixPrices = false, trail = null, breakEven = 0, iv = 0.14, lockStart = 1000, lockGap = 250, steps = null, lotSize = DEFAULT_LOT_SIZE, holidays = [], expiryWeekday = DEFAULT_EXPIRY_WEEKDAY, strikeStep = STRIKE_STEP, lossLimit = 0, maxLots = 2, target = 0, fixedLots = 0, exitMin = EXIT_MIN, chase = null, cut = 0 } = noStop ? { ...merged, trail: null, breakEven: 0, cut: 0, steps: noStop.at > 0 ? [{ at: noStop.at, keep: noStop.keep }] : [], target: 0 } : merged;
  const start = byTime.get(signal.time);
  if (start == null) return null;
  const prices = given && (!mixPrices || given.hasDay(istParts(new Date(signal.time * 1000)).dateKey)) ? given : null; // mixPrices: a day with no saved premiums is estimated, not skipped
  if (istParts(new Date(signal.time * 1000)).minutes >= exitMin) return null; // no new trade at or after the time you close
  const long = signal.side === 'CE';
  const entryBar = c1[start];
  const entryAt = new Date(entryBar.time * 1000);
  const strike = atmStrike(entryBar.open, strikeStep);
  // With saved real premiums (`prices`) the trade is priced from its contract's own candles, and only a trade whose contract was saved that day is taken.
  // Otherwise every premium is estimated with Black-Scholes at the fixed volatility.
  const entryDay = istParts(entryAt).dateKey;
  const expiry = prices ? chooseExpiry(prices.expiries(entryDay), entryAt, { minDays: 1 }) : chooseExpiry(weeklyExpiries(entryAt, { holidays, weekday: expiryWeekday }), entryAt, { minDays: 1 });
  const real = prices && expiry ? prices.contract(entryDay, expiry, strike, signal.side) : null;
  if (prices && !real?.has(entryBar.time)) {
    prices.stats.noPrice += 1;
    return null;
  }
  if (!expiry) return null;
  const yearsAt = (time) => yearsToExpiry(expiry, new Date(time * 1000));
  // a level the contract never traded at (the stop, a target) is priced by the model, set to the volatility the real entry premium implies
  const modelIv = real ? Math.min(Math.max(impliedVol({ type: signal.side, spot: entryBar.open, strike, t: yearsAt(entryBar.time), premium: real.get(entryBar.time).open }) ?? iv, 0.05), 0.8) : iv;
  // `kind` names which of the minute's four real prices the call means (the open, the close, the worst or the best for the buyer); without one, or without a candle, the model prices it
  const premiumAt = (spot, time, kind) => {
    const c = real && kind ? real.get(time) : null;
    return c && c[kind] > 0 ? c[kind] : bsPrice({ type: signal.side, spot, strike, t: yearsAt(time), iv: modelIv });
  };
  // how far the real premium had already run up from its low of the last minutes (the anti-chase check); unknown without saved prices
  const chaseMin = chase?.minutes ?? 15;
  const rise = real ? chaseRise(candlesBefore(real, entryBar.time, chaseMin), real.get(entryBar.time).open, { now: entryBar.time, minutes: chaseMin }) : null;
  if (chaseSkip(rise, chase)) return { skipped: 'chase', rise };
  const paid = premiumAt(entryBar.open, entryBar.time, 'open') * (1 + SLIPPAGE);
  if (paid < 1) return null;
  let lots = 1;
  if (lossLimit > 0) {
    const atStop = premiumAt(signal.stop, entryBar.time) * (1 - SLIPPAGE);
    const perLot = Math.max(paid - atStop, 0.05) * lotSize;
    let fits = Math.floor(lossLimit / perLot);
    // as live: the loss at the chart stop plus the round-trip charges must fit the limit
    while (fits > 0 && fits * perLot + roundTrip(fits * lotSize, paid) > lossLimit) fits -= 1;
    lots = Math.min(fixedLots > 0 ? fixedLots : maxLots, fits);
    if (lots < 1) return { skipped: 'limit' };
  } else if (fixedLots > 0) lots = fixedLots;
  const qty = lots * lotSize;
  const targetProfit = target > 0 ? target * lots : 0;
  // the profit lock as rows: with `steps` (even none) those rows, otherwise the single row lockStart / lockGap; each row is sorted by its profit
  const rungs = (Array.isArray(steps) ? steps : [{ at: lockStart, keep: lockStart - lockGap }]).filter((r) => r.at > 0).sort((a, b) => a.at - b.at);
  // the hard stop, as live: the gross loss at which the loss after charges reaches the limit (never closer than half the limit)
  const hardLoss = noStop ? -STOP_OFF_FLOOR * paid * qty : lossLimit > 0 ? -Math.max(HARD_STOP_MULT * lossLimit - roundTrip(qty, paid), lossLimit * 0.5) : -Infinity;
  const hardWhy = noStop ? 'FLOOR' : 'HARD';
  const buyCharges = calculateCharges({ side: 'BUY', qty, price: paid, segment: 'OPT' }).total;
  const profitAt = (premium) => (premium * (1 - SLIPPAGE) - paid) * qty;
  const day = istParts(entryAt).dateKey;

  // bot-calculated stop and targets (combos/bot.js) in place of the ladder: parts sold at each target, the stop moving up after each
  const bot = signal.bot && !noStop && !(target > 0) ? signal.bot : null;
  if (bot) {
    const run = botPath({ c1, start, day, exitMin, long, bot, lots, lotSize, qty, paid, premiumAt, profitAt, chartStop: signal.stop, hardLoss });
    const charges = round2(buyCharges + run.sellCharges);
    if (prices) prices.stats.used += 1;
    return {
      technique: signal.technique,
      side: signal.side,
      bar: signal.i ?? null,
      note: signal.note,
      tag: signal.tag,
      score: signal.score,
      lots,
      entryTime: entryBar.time,
      exitTime: run.exit.time,
      entrySpot: round2(entryBar.open),
      exitSpot: round2(run.exit.spot),
      stop: round2(signal.stop),
      strike,
      expiry,
      priced: real ? 'real' : 'estimated',
      entryPremium: round2(paid),
      gross: round2(run.gross),
      charges,
      net: round2(run.gross - charges),
      reason: run.exit.reason,
      minutes: Math.max(1, Math.round((run.exit.time - entryBar.time) / 60)),
      best: round2(run.best),
      worst: round2(run.worst),
      rise,
      bot: { hit: run.hit, sold: run.sold },
    };
  }

  let best = 0;
  let worst = 0;
  let stopNow = signal.stop; // the chart level; a trailing stop moves it up (down for a put) and never back
  let stopWhy = 'STOP'; // which rule last moved the stop: the chart level, break-even or the trailing stop
  let lockLevel = null; // a profit in rupees; the trade is sold when it falls to it
  let exit = null;
  for (let j = start; j < c1.length; j++) {
    const bar = c1[j];
    const at = istParts(new Date(bar.time * 1000));
    if (at.dateKey !== day) {
      const prev = c1[j - 1];
      exit = { time: prev.time + 60, spot: prev.close, profit: profitAt(premiumAt(prev.close, prev.time, 'close')), reason: 'EOD' };
      break;
    }
    if (at.minutes >= exitMin) {
      exit = { time: bar.time, spot: bar.open, profit: profitAt(premiumAt(bar.open, bar.time, 'open')), reason: 'EOD' };
      break;
    }
    const against = long ? bar.low : bar.high;
    const favour = long ? bar.high : bar.low;
    if (targetProfit > 0) {
      const gap = profitAt(premiumAt(bar.open, bar.time, 'open'));
      if (gap >= targetProfit) {
        exit = { time: bar.time, spot: bar.open, profit: gap, reason: 'TARGET' };
        break;
      }
    }
    if (lockLevel != null) {
      const open = profitAt(premiumAt(bar.open, bar.time, 'open'));
      const low = profitAt(premiumAt(against, bar.time, 'low'));
      if (open <= lockLevel) {
        exit = { time: bar.time, spot: bar.open, profit: open, reason: 'LOCK' };
        break;
      }
      if (low <= lockLevel) {
        exit = { time: bar.time, spot: against, profit: lockLevel, reason: 'LOCK' };
        break;
      }
    }
    const closeProfit = profitAt(premiumAt(bar.close, bar.time, 'close'));
    if (cut > 0) {
      // the combination's own loss cut (exits.cut): sold once the trade is this many rupees down, wherever the chart stop is
      const open = profitAt(premiumAt(bar.open, bar.time, 'open'));
      const low = profitAt(premiumAt(against, bar.time, 'low'));
      if (open <= -cut || low <= -cut) {
        worst = Math.min(worst, open <= -cut ? open : -cut);
        exit = { time: bar.time, spot: open <= -cut ? bar.open : against, profit: open <= -cut ? open : -cut, reason: 'CUT' };
        break;
      }
    }
    if (hardLoss > -Infinity) {
      const open = profitAt(premiumAt(bar.open, bar.time, 'open'));
      const low = profitAt(premiumAt(against, bar.time, 'low'));
      if (open <= hardLoss || low <= hardLoss) {
        exit = { time: bar.time, spot: open <= hardLoss ? bar.open : against, profit: Math.min(open <= hardLoss ? open : hardLoss, hardLoss), reason: hardWhy };
        break;
      }
    }
    worst = Math.min(worst, profitAt(premiumAt(against, bar.time, 'low')));
    if (!noStop && (long ? bar.close < stopNow : bar.close > stopNow)) {
      exit = { time: bar.time + 60, spot: bar.close, profit: closeProfit, reason: stopWhy };
      break;
    }
    best = Math.max(best, profitAt(premiumAt(favour, bar.time, 'high')));
    const gained = long ? favour - entryBar.open : entryBar.open - favour;
    if (breakEven > 0 && gained >= breakEven && (long ? entryBar.open > stopNow : entryBar.open < stopNow)) {
      stopNow = entryBar.open;
      stopWhy = 'BREAKEVEN';
    }
    if (trail) {
      const moved = gained;
      if (moved >= trail.start) {
        const level = long ? favour - trail.points : favour + trail.points;
        if (long ? level > stopNow : level < stopNow) {
          stopNow = level;
          stopWhy = 'TRAIL';
        }
      }
    }
    if (targetProfit > 0) {
      if (best >= targetProfit) {
        // the bar reached the target: find the index level where it was crossed (a stop in the same bar was checked first, the cautious order)
        let lo = bar.open;
        let hi = favour;
        for (let k = 0; k < 30; k++) {
          const mid = (lo + hi) / 2;
          if (profitAt(premiumAt(mid, bar.time)) >= targetProfit) hi = mid;
          else lo = mid;
        }
        exit = { time: bar.time + 60, spot: hi, profit: targetProfit, reason: 'TARGET' };
        break;
      }
    } else {
      const rung = rungs.filter((r) => best >= r.at).at(-1);
      if (rung) lockLevel = Math.max(lockLevel ?? -Infinity, Math.max(rung.keep, best - (rung.at - rung.keep)));
    }
  }
  if (!exit) {
    const last = c1.at(-1);
    exit = { time: last.time + 60, spot: last.close, profit: profitAt(premiumAt(last.close, last.time, 'close')), reason: 'EOD' };
  }
  const sellPremium = (exit.profit / qty + paid) / (1 - SLIPPAGE);
  const charges = round2(buyCharges + calculateCharges({ side: 'SELL', qty, price: Math.max(sellPremium, 0.05), segment: 'OPT' }).total);
  if (prices) prices.stats.used += 1;
  return {
    technique: signal.technique,
    side: signal.side,
    bar: signal.i ?? null, // the 5-minute bar that gave the signal, for explaining the entry
    note: signal.note,
    tag: signal.tag,
    score: signal.score,
    lots,
    entryTime: entryBar.time,
    exitTime: exit.time,
    entrySpot: round2(entryBar.open),
    exitSpot: round2(exit.spot),
    stop: round2(signal.stop),
    strike,
    expiry,
    priced: real ? 'real' : 'estimated',
    entryPremium: round2(paid),
    gross: round2(exit.profit),
    charges,
    net: round2(exit.profit - charges),
    reason: exit.reason,
    minutes: Math.max(1, Math.round((exit.time - entryBar.time) / 60)),
    best: round2(best),
    worst: round2(worst),
    rise,
    ...(noStop ? { noStop: true } : {}),
  };
}

/**
 * One trade with the bot's stop and targets (combos/bot.js), on 1-minute bars, the cautious way round inside a bar: the stop first,
 * then the targets. Before the first target the stop is the bot stop (rupees a lot); after it the entry plus the charges; after the
 * second the first target. The chart stop (a 1-minute close beyond the level) and the hard stop still sell what is left.
 */
function botPath({ c1, start, day, exitMin, long, bot, lots, lotSize, qty, paid, premiumAt, profitAt, chartStop, hardLoss }) {
  const lotsAt = allot(lots, bot.targets);
  const perLot = (premium) => profitAt(premium) / qty * lotSize; // rupees a lot at this premium
  const chargesLot = (calculateCharges({ side: 'BUY', qty: lotSize, price: paid, segment: 'OPT' }).total + calculateCharges({ side: 'SELL', qty: lotSize, price: paid, segment: 'OPT' }).total);
  const hardLot = hardLoss > -Infinity ? hardLoss / lots : -Infinity;
  let left = lots;
  let hit = 0;
  let gross = 0;
  let sellCharges = 0;
  let best = 0;
  let worst = 0;
  const sold = [];
  const sell = (n, lotProfit, why, time, spot) => {
    if (n <= 0) return;
    gross += lotProfit * n;
    const premium = Math.max((lotProfit / lotSize + paid) / (1 - SLIPPAGE), 0.05);
    sellCharges += calculateCharges({ side: 'SELL', qty: n * lotSize, price: premium, segment: 'OPT' }).total;
    sold.push({ lots: n, at: round2(lotProfit), why });
    left -= n;
    return { time, spot, reason: why };
  };
  let exit = null;
  for (let j = start; j < c1.length && left > 0; j++) {
    const bar = c1[j];
    const at = istParts(new Date(bar.time * 1000));
    if (at.dateKey !== day) {
      const prev = c1[j - 1];
      exit = sell(left, perLot(premiumAt(prev.close, prev.time, 'close')), 'EOD', prev.time + 60, prev.close);
      break;
    }
    if (at.minutes >= exitMin) {
      exit = sell(left, perLot(premiumAt(bar.open, bar.time, 'open')), 'EOD', bar.time, bar.open);
      break;
    }
    const against = long ? bar.low : bar.high;
    const favour = long ? bar.high : bar.low;
    const open = perLot(premiumAt(bar.open, bar.time, 'open'));
    const low = perLot(premiumAt(against, bar.time, 'low'));
    const level = Math.max(stopAfter(bot, hit, chargesLot), hardLot);
    const why = hit === 0 ? (level === hardLot ? 'HARD' : 'CUT') : 'LOCK';
    if (open <= level || low <= level) {
      worst = Math.min(worst, (open <= level ? open : level) * lots);
      exit = sell(left, open <= level ? open : level, why, bar.time, open <= level ? bar.open : against);
      break;
    }
    worst = Math.min(worst, low * lots);
    const close = perLot(premiumAt(bar.close, bar.time, 'close'));
    if (long ? bar.close < chartStop : bar.close > chartStop) {
      exit = sell(left, close, 'STOP', bar.time + 60, bar.close);
      break;
    }
    const high = perLot(premiumAt(favour, bar.time, 'high'));
    best = Math.max(best, high * lots);
    while (hit < bot.targets.length && left > 0 && high >= bot.targets[hit].at) {
      const t = bot.targets[hit];
      const last = hit === bot.targets.length - 1;
      const done = sell(last ? left : Math.min(left, lotsAt[hit]), Math.max(t.at, open), `TARGET${hit + 1}`, bar.time + 60, favour);
      hit += 1;
      if (left === 0) exit = { ...done, reason: 'TARGET' };
    }
  }
  if (!exit) {
    const last = c1.at(-1);
    exit = sell(left, perLot(premiumAt(last.close, last.time, 'close')), 'EOD', last.time + 60, last.close) ?? { time: last.time + 60, spot: last.close, reason: 'EOD' };
  }
  return { exit, gross, sellCharges, best, worst, hit, sold };
}

/** The numbers that say whether a set of trades is worth following. Rupees are for one lot, after charges. */
export function summarize(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const net = round2(sum(trades, (t) => t.net));
  const grossWin = sum(wins, (t) => t.net);
  const grossLoss = -sum(losses, (t) => t.net);
  let run = 0;
  let peak = 0;
  let drawdown = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    run += t.net;
    peak = Math.max(peak, run);
    drawdown = Math.max(drawdown, peak - run);
  }
  const bySide = {};
  for (const side of ['CE', 'PE']) {
    const xs = trades.filter((t) => t.side === side);
    bySide[side] = { trades: xs.length, wins: xs.filter((t) => t.net > 0).length, net: round2(sum(xs, (t) => t.net)) };
  }
  const byHour = {};
  for (const t of trades) {
    const h = String(Math.floor(istParts(new Date(t.entryTime * 1000)).minutes / 60)).padStart(2, '0');
    byHour[h] = byHour[h] || { trades: 0, net: 0 };
    byHour[h].trades += 1;
    byHour[h].net = round2(byHour[h].net + t.net);
  }
  const byExit = {};
  for (const t of trades) byExit[t.reason] = (byExit[t.reason] || 0) + 1;
  return {
    trades: n,
    wins: wins.length,
    winRate: n ? Math.round((wins.length / n) * 100) : null,
    net,
    avgNet: n ? round2(net / n) : null,
    avgWin: wins.length ? round2(grossWin / wins.length) : null,
    avgLoss: losses.length ? round2(-grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
    best: n ? round2(Math.max(...trades.map((t) => t.net))) : null,
    worst: n ? round2(Math.min(...trades.map((t) => t.net))) : null,
    maxDrawdown: round2(drawdown),
    avgMinutes: n ? Math.round(sum(trades, (t) => t.minutes) / n) : null,
    bySide,
    byHour,
    byExit,
  };
}
