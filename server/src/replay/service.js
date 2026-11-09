import mongoose from 'mongoose';
import { AutoLog, AutoSettings, OptionSettings, Order, Position, Trade } from '../models/index.js';
import { OptionHistoryStore } from '../market/optionHistory.js';
import { NIFTY50 } from '../market/instruments.js';
import { istParts } from '../market/marketHours.js';
import { addDays } from '../market/days.js';
import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { INDEXES, DEFAULT_INDEX, lotSizeOf, parseOptionSymbol, optionLabel, yearsToExpiry } from '../options/symbols.js';
import { bsPrice, impliedVol } from '../options/pricing.js';
import { forIndex } from '../options/indexSettings.js';
import { entryTest, entryWindowOf } from '../options/signal.js';
import { normalizeCombos, missingData } from '../combos/combos.js';
import { buildChart } from '../combos/conditions.js';
import { shareChart, breadthByTime } from '../combos/shares.js';
import { breadthSeries } from '../study/optionsStudy.js';
import { turnoverSeries } from '../study/patterns.js';
import { round2, roundToTick } from '../utils/money.js';
import { notFound } from '../utils/errors.js';
import { lessons, minuteRows, pathSummary, replayIndexStop, replayPriceStop } from './path.js';
import { closedBars5, entryReasons, sourceOf } from './why.js';

export const REPLAY_NOTE = 'Rebuilt from 1-minute candles. The live engine checks every tick, so a stop can have moved a little earlier or later than shown. Paper trading for learning. Not investment advice.';

const BEFORE_MIN = 30; // minutes of chart shown before the entry
const AFTER_MIN = 20; // and after the exit
const EXIT_TEXT = { STOP: 'Stopped out', LOCK: 'Locked profit', TARGET: 'Target hit', MANUAL: 'Exited by hand', SQUARE_OFF: '15:15 square-off', TIME: 'Time exit', TRAIL: 'Trailing stop', BREAKEVEN: 'Break-even stop' };
const ROLE_TEXT = { STOPLOSS: 'Stop hit', TARGET: 'Target hit', SQUAREOFF: 'Square-off / exit all', EXIT: 'Exited', ENTRY: 'Closed by an opposite order' };

const sec = (d) => Math.floor(new Date(d).getTime() / 1000);
const pick = (c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
const dayOfTime = (t) => istParts(new Date(t * 1000)).dateKey;

/** A trade, one minute at a time, with the reason it was taken and the moments that decided it. */
export class TradeReplayService {
  constructor({ market, config = {}, optionStore = new OptionHistoryStore(), now = () => new Date() }) {
    this.market = market;
    this.config = config;
    this.optionStore = optionStore;
    this.now = now;
  }

  async replay(userId, positionId) {
    if (!mongoose.isValidObjectId(positionId)) throw notFound('No such trade');
    const pos = await Position.findOne({ _id: positionId, user: userId }).lean();
    if (!pos) throw notFound('No such trade');
    const option = parseOptionSymbol(pos.symbol);
    const long = pos.direction === 'LONG';
    const day = pos.tradingDay;
    const [fills, log] = await Promise.all([
      Trade.find({ user: userId, position: pos._id }).sort({ executedAt: 1 }).lean(),
      AutoLog.findOne({ user: userId, position: pos._id }).lean().then((l) => l ?? AutoLog.findOne({ user: userId, symbol: pos.symbol, day, decision: 'PLACED', decidedAt: { $gte: new Date(new Date(pos.openedAt).getTime() - 120_000), $lte: new Date(new Date(pos.openedAt).getTime() + 120_000) } }).lean()),
    ]);
    const entryFills = fills.filter((f) => (long ? f.side === 'BUY' : f.side === 'SELL'));
    const exitFills = fills.filter((f) => (long ? f.side === 'SELL' : f.side === 'BUY'));
    const qty = Math.max(pos.buyQty, pos.sellQty) || Math.abs(pos.netQty);
    const avg = long ? (pos.buyQty ? pos.buyValue / pos.buyQty : pos.avgPrice) : pos.sellQty ? pos.sellValue / pos.sellQty : pos.avgPrice;
    const exitAvg = pos.status === 'CLOSED' ? (long ? (pos.sellQty ? pos.sellValue / pos.sellQty : null) : pos.buyQty ? pos.buyValue / pos.buyQty : null) : null;
    const entryTime = sec(entryFills[0]?.executedAt ?? pos.openedAt);
    const open = pos.status !== 'CLOSED';
    const exitTime = open ? sec(this.now()) : sec(exitFills.at(-1)?.executedAt ?? pos.closedAt);
    const orderIds = [...new Set(fills.map((f) => String(f.order)))];
    const orders = orderIds.length ? await Order.find({ _id: { $in: orderIds } }).lean() : [];
    const entryOrder = orders.find((o) => String(o._id) === String(entryFills[0]?.order));
    const exitOrder = orders.find((o) => String(o._id) === String(exitFills.at(-1)?.order));
    const ltp = this.market.getLtp?.(pos.symbol) ?? null;

    // the minutes of what was traded
    const index = option?.index ?? null;
    const indexSymbol = index ? INDEXES[index].symbol : null;
    const indexMinutes = index ? (await this.market.getMinutes(indexSymbol, day).catch(() => [])).filter((c) => dayOfTime(c.time) === day) : [];
    let priceSource = 'real';
    let candles;
    if (option) {
      candles = await this.#optionMinutes(pos.symbol, day);
      if (!candles.length) {
        candles = estimateOption({ symbol: pos.symbol, indexMinutes, entryTime, entryPrice: avg });
        priceSource = candles.length ? 'estimated' : 'none';
      }
    } else {
      candles = (await this.market.getMinutes(pos.symbol, day).catch(() => [])).filter((c) => dayOfTime(c.time) === day).map(pick);
      if (!candles.length) priceSource = 'none';
    }

    const exitPrice = open ? ltp : exitAvg;
    const rows = minuteRows({ candles, long, avg, qty, entryTime, exitTime, exitPrice });
    const initialStop = entryOrder?.stopLoss ?? log?.stopLoss ?? null;
    const exits = { stopLoss: initialStop, lockSteps: pos.lockSteps, lockTrigger: pos.lockTrigger, lockAmount: pos.lockAmount, lockRatio: pos.lockRatio, trailPct: pos.trailPct, stepPrices: pos.stepPrices, segment: pos.segment };
    const stopEvents = replayPriceStop(rows, { long, avg, qty, exits });
    const d = log?.detail ?? {};
    const indexPlan = option && log
      ? {
          candles: indexMinutes,
          long: option.type === 'CE',
          entrySpot: d.entrySpot ?? d.spot ?? null,
          stopSpot: d.firstStopSpot ?? firstStopFromNote(d.stopNote) ?? d.stopSpot ?? null,
          breakEven: Number(d.breakEven) || 0,
          trail: d.trail && Number(d.trail.points) > 0 ? { points: Number(d.trail.points), start: Number(d.trail.start) || Number(d.trail.points) } : null,
        }
      : null;
    const indexEvents = indexPlan ? replayIndexStop(rows, indexPlan) : [];
    const summary = pathSummary(rows);

    // how it ended
    const gross = open ? (rows.at(-1)?.pnl ?? 0) : round2(pos.realizedPnl);
    const charges = round2(pos.charges);
    const net = round2(gross - charges);
    const exitReason = log?.outcome?.exitReason ?? null;
    const exitLabel = open ? 'Still open' : exitReason ? EXIT_TEXT[exitReason] : ROLE_TEXT[exitOrder?.role] ?? 'Closed';
    const plannedRisk = initialStop != null ? round2(Math.abs(avg - initialStop) * qty) : null;
    const lotSize = option ? d.lotSize ?? (this.market.lotSize?.(pos.symbol) || lotSizeOf(index, this.config)) : null;
    const lots = option && lotSize ? Math.round(qty / lotSize) : null;
    const said = [...(priceSource === 'estimated' ? [{ tone: 'warn', text: 'No saved prices for this contract on this day, so each minute’s premium is estimated from the index. The minute P&L is close, not exact; the real entry and exit prices are used where known.' }] : priceSource === 'none' ? [{ tone: 'warn', text: 'No minute prices are saved for this day, so the minute-by-minute view is empty. Share minutes are kept 3 months and option prices 30 days.' }] : []), ...lessons({ summary, net, gross, charges, plannedRisk, exits, qty, lots, lotSize, segment: pos.segment, exitLabel, stopEvents })];

    // why it was taken
    const why = await this.#why({ userId, pos, log, option, index, indexMinutes, long, entryTime, day });

    const events = buildEvents({ rows, entryTime, exitTime, avg, long, open, exitLabel, exitPrice, summary, stopEvents, indexEvents, initialStop, index: index ? INDEXES[index].short : null });

    const from = entryTime - BEFORE_MIN * 60;
    const to = exitTime + AFTER_MIN * 60;
    return {
      id: String(pos._id),
      symbol: pos.symbol,
      label: option ? optionLabel(pos.symbol) : pos.symbol,
      segment: pos.segment,
      day,
      side: option ? option.type : long ? 'BUY' : 'SELL',
      direction: pos.direction,
      status: pos.status,
      source: log ? (d.manual ? 'MANUAL' : 'AUTO') : 'MANUAL',
      qty,
      lots,
      lotSize,
      entry: { time: entryTime, price: round2(avg), stop: initialStop, spot: indexPlan?.entrySpot ?? null, stopSpot: indexPlan?.stopSpot ?? null },
      exit: { time: exitTime, price: exitPrice != null ? round2(exitPrice) : null, reason: exitReason, label: exitLabel, finalStop: rows.at(-1)?.stop ?? null },
      result: { gross, charges, net, plannedRisk, minutes: Math.max(1, Math.round((exitTime - entryTime) / 60)) },
      exits: { lockSteps: pos.lockSteps ?? [], lockTrigger: pos.lockTrigger, lockAmount: pos.lockAmount, trailPct: pos.trailPct, indexTrail: indexPlan?.trail ?? null, breakEven: indexPlan?.breakEven || 0 },
      priceSource,
      summary,
      lessons: said,
      minutes: rows,
      events,
      chart: candles.filter((c) => c.time >= from && c.time <= to).map(pick),
      indexChart: indexMinutes.filter((c) => c.time >= from && c.time <= to).map(pick),
      why,
      note: REPLAY_NOTE,
    };
  }

  /** The contract's saved 1-minute prices; for today (saved only after the close) the broker's candles of today. */
  async #optionMinutes(symbol, day) {
    const saved = await this.optionStore.read(symbol, day, day).catch(() => []);
    if (saved.length) return saved.map(pick);
    if (day !== istParts(this.now()).dateKey) return [];
    const live = await Promise.resolve(this.market.provider?.getTodayOptionCandles?.(symbol, 1)).catch(() => []);
    return (live ?? []).filter((c) => dayOfTime(c.time) === day).map(pick);
  }

  async #why({ userId, pos, log, option, index, indexMinutes, long, entryTime, day }) {
    const d = log?.detail ?? {};
    const base = {
      setup: log?.setup ?? null,
      score: log?.score ?? null,
      manual: !log || Boolean(d.manual),
      checks: log?.card?.checks?.length ? log.card.checks.map((c) => ({ label: c.label, text: c.text, points: c.points, max: c.max })) : [],
      stopNote: d.stopNote ?? null,
      planned: log ? { entry: log.entry, stopLoss: log.stopLoss, target1: log.target1 ?? null, maxLoss: d.maxLoss ?? null, iv: d.iv ?? null, lots: d.lots ?? null } : null,
    };
    if (!log || d.manual) return { ...base, source: { kind: 'manual' }, text: 'You placed this trade yourself, so no pattern or combination chose it.' };
    let combos = [];
    if (option) combos = normalizeCombos(forIndex(await OptionSettings.findOne({ user: userId }).lean(), index)?.combos);
    else combos = normalizeCombos((await AutoSettings.findOne({ user: userId }).lean())?.combos);
    let source = sourceOf(log.setup, { combos, detailCombo: d.combo ?? null, comboId: d.comboId ?? null });
    // a share's scanner setup can share a name with an index pattern ("Opening range breakout"): for shares only combinations are read again
    if (!option && source.kind === 'pattern') source = { kind: 'setup', name: log.setup };
    const side = option ? option.type : long ? 'CE' : 'PE';
    const out = { ...base, source: { kind: source.kind, name: source.combo?.name ?? source.technique?.label ?? source.name ?? log.setup, id: source.combo?.id ?? source.technique?.key ?? null, savedAtEntry: Boolean(source.saved) } };
    if (source.kind === 'combo' && !source.combo) return { ...out, note: `The combination "${source.name}" is not in your saved list any more, so its checks cannot be read again.` };
    if (option && source.kind !== 'combo' && source.kind !== 'pattern') return out;
    try {
      let reasons;
      if (option) {
        const minutes = await this.market.getMinutes(INDEXES[index ?? DEFAULT_INDEX].symbol, day).catch(() => indexMinutes);
        const bars5 = closedBars5(minutes.filter((c) => dayOfTime(c.time) <= day));
        const settings = forIndex(await OptionSettings.findOne({ user: userId }).lean(), index);
        const when = entryTest(entryWindowOf(settings));
        let chartOf = (b) => buildChart(b);
        if (source.kind === 'combo' && missingData(source.combo, { breadth: false, flow: false, news: false }).length) {
          const stocks5 = await this.#stocks5(day);
          if (stocks5) chartOf = (b) => buildChart(b, { breadth: breadthSeries(b, stocks5), flow: turnoverSeries(b, stocks5) });
        }
        // an entry "on the minute" or "on the second" was read on the 5-minute bar still forming, so it is read again that way
        reasons = entryReasons({ bars5, entryTime, side, source, chartOf, when, clock: d.clock ?? null, c1: minutes.filter((c) => dayOfTime(c.time) === day), spot: d.entrySpot ?? null });
      } else {
        const minutes = await this.market.getMinutes(pos.symbol, day).catch(() => []);
        const bars5 = closedBars5(minutes.filter((c) => dayOfTime(c.time) <= day));
        let chartOf = (b) => shareChart(b);
        if (source.kind === 'combo' && missingData(source.combo, { breadth: false, flow: true, news: false }).includes('breadth')) {
          const stocks5 = await this.#stocks5(day);
          if (stocks5) chartOf = (b) => shareChart(b, { breadth: breadthByTime(b, stocks5) });
        }
        reasons = entryReasons({ bars5, entryTime, side, source, chartOf });
      }
      return { ...out, ...reasons };
    } catch (e) {
      return { ...out, note: `The chart at the entry could not be read again: ${e.message}` };
    }
  }

  /** The 50 stocks' saved 5-minute candles around `day`, or null when none are saved (breadth and volume checks then cannot be read). */
  async #stocks5(day) {
    const history = this.market.history;
    if (!history) return null;
    const out = {};
    for (const { symbol } of NIFTY50) {
      const stored = await history.read(symbol, addDays(day, -9), addDays(day, 1)).catch(() => []);
      if (stored.length) out[symbol] = aggregateCandles(stored.map((c) => ({ ...c })), '5m');
    }
    return Object.keys(out).length >= 30 ? out : null;
  }
}

/** "…; stop at NIFTY 24350" in the trader's stop note: the first chart stop, before any trail moved it. */
export function firstStopFromNote(note) {
  const m = String(note || '').match(/stop at \S+ (\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/**
 * With no saved option prices, the premium each minute is estimated from the index: the model premium, at the volatility that
 * matches the real entry price, so the first minute starts where the trade really started.
 */
export function estimateOption({ symbol, indexMinutes, entryTime, entryPrice }) {
  const o = parseOptionSymbol(symbol);
  if (!o || !indexMinutes.length || !(entryPrice > 0)) return [];
  const at = indexMinutes.reduce((best, c) => (Math.abs(c.time - entryTime) < Math.abs(best.time - entryTime) ? c : best), indexMinutes[0]);
  const tOf = (t) => yearsToExpiry(o.expiry, new Date(t * 1000));
  const iv = impliedVol({ type: o.type, spot: at.close, strike: o.strike, t: tOf(at.time), premium: entryPrice }) ?? 0.14;
  const price = (spot, t) => roundToTick(Math.max(0.05, bsPrice({ type: o.type, spot, strike: o.strike, t: tOf(t), iv })));
  const call = o.type === 'CE';
  return indexMinutes.map((c) => ({ time: c.time, open: price(c.open, c.time), high: price(call ? c.high : c.low, c.time), low: price(call ? c.low : c.high, c.time), close: price(c.close, c.time) }));
}

const clock = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t * 1000));
const rs = (n) => `${n >= 0 ? '+' : '-'}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;

/** The moments that decided the trade, in time order: entry, first profit, the best and worst points, stop moves, the exit. */
export function buildEvents({ rows, entryTime, exitTime, avg, long, open, exitLabel, exitPrice, summary, stopEvents, indexEvents, initialStop, index }) {
  const out = [{ time: entryTime, kind: 'entry', text: `${long ? 'Bought' : 'Sold'} at ${round2(avg)}${initialStop != null ? `, stop ${initialStop}` : ', no stop'}` }];
  if (summary) {
    const firstUp = rows.find((r) => r.pnl > 0);
    const firstDown = rows.find((r) => r.pnl < 0);
    if (firstUp && firstUp.min <= 15) out.push({ time: firstUp.time, kind: 'green', text: `In profit ${rs(firstUp.pnl)} after ${firstUp.min} min` });
    if (firstDown && firstDown.min <= 3 && (!firstUp || firstDown.min < firstUp.min)) out.push({ time: firstDown.time, kind: 'red', text: `Already ${rs(firstDown.pnl)} in minute ${firstDown.min}` });
    if (summary.peakTime) out.push({ time: summary.peakTime, kind: 'peak', text: `Best point ${rs(summary.peak)} (minute ${summary.peakMin})` });
    if (summary.troughTime) out.push({ time: summary.troughTime, kind: 'trough', text: `Worst point ${rs(summary.trough)} (minute ${summary.troughMin})` });
    const peak = rows.find((r) => r.time === summary.peakTime);
    if (peak && summary.final < 0) {
      const turned = rows.find((r) => r.time > peak.time && r.pnl < 0);
      if (turned) out.push({ time: turned.time, kind: 'red', text: `Back into loss ${rs(turned.pnl)} (minute ${turned.min})` });
    }
  }
  for (const e of stopEvents) out.push({ time: e.time, kind: 'stop', text: e.text });
  for (const e of indexEvents) out.push({ time: e.time, kind: e.kind, text: index ? e.text.replace('The index', `The ${index}`) : e.text });
  out.push(open ? { time: exitTime, kind: 'now', text: `Still open${exitPrice != null ? ` at ${round2(exitPrice)}` : ''}` } : { time: exitTime, kind: 'exit', text: `${exitLabel}${exitPrice != null ? ` at ${round2(exitPrice)}` : ''}` });
  return out.sort((a, b) => a.time - b.time || (a.kind === 'entry' ? -1 : b.kind === 'entry' ? 1 : 0));
}
