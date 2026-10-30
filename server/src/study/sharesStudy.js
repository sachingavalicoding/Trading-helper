import { replayStock, followLive } from '../scanner/replay.js';
import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { CONDITIONS, usable } from '../combos/conditions.js';
import { describeCombo, missingData, singleCombo } from '../combos/combos.js';
import { bars5Of, breadthByTime, shareChart, shareIdeas } from '../combos/shares.js';
import { verdictOf } from '../combos/verdict.js';
import { findPairs, findCombos, pairStart } from './pairFinder.js';
import { evaluate, evaluateBy, netResult, targetTable } from '../scanner/backtest.js';
import { istParts } from '../market/marketHours.js';

// The shares study: the live scanner's rules replayed over past 1-minute candles of the Nifty 50, as paper trades sized to the Account stop.
// It reads history and changes nothing. The replay has no order book. Its exits are in rupees on the shares it would buy: your profit
// ladder from the Account page (`steps`), or a fixed rupee `target` with no lock. The stop is the scanner's chart stop.

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));
const hourOf = (i) => `${String(Math.floor(istParts(new Date(i.openedAt)).minutes / 60)).padStart(2, '0')}:00`;
const DAY = (t) => Math.floor((t + 19800) / 86400);
const EXIT_WORD = { STOP: 'Stop hit', LOCK: 'Profit lock', SQUARE_OFF: 'Closed on time', TARGET: 'Target' };

/**
 * @param nifty1   Nifty 1-minute candles
 * @param history  { SYMBOL: 1-minute candles }, a few sessions longer than `days` so the indicators have context
 * @param params   { days, exitMin (the minute of the day, IST, everything is closed), riskAmount, slippagePct, steps (the Account ladder), target (rupees a trade; with it there is no lock) }
 */
export async function runSharesStudy({ nifty1, history, params, onProgress = () => {} }) {
  const opts = { riskAmount: params.riskAmount || 1000, slippagePct: params.slippagePct ?? 0.05 };
  const target = params.target > 0 ? params.target : 0;
  const exitMin = params.exitMin > 0 ? params.exitMin : 15 * 60 + 15;
  const money = { ...opts, steps: params.steps ?? [], target, exitMin };
  const ideas = [];
  const symbols = Object.keys(history).filter((s) => history[s]?.length > 100);
  for (const [n, symbol] of params.finderOnly ? [] : symbols.entries()) {
    onProgress(`Replaying the scanner on ${symbol} (${n + 1}/${symbols.length})`);
    ideas.push(...replayStock({ symbol, c1: history[symbol], nifty: nifty1, days: params.days, exits: 'live', money }));
    await yieldTurn();
  }
  const needRank = params.finderOnly ? (params.pairFind && !params.pairFirst) || params.comboFind : params.rank !== false;
  const extra = await comboStudy({ nifty1, history, symbols, params: { ...params, rank: needRank }, money, opts, onProgress });
  if (params.finderOnly) return { generatedAt: new Date().toISOString(), finderOnly: true, period: { days: params.days, stocks: symbols.length }, params: { days: params.days, riskAmount: opts.riskAmount, slippagePct: opts.slippagePct, exit: target ? 'target' : 'lock', target, steps: money.steps, exitMin }, ...extra };
  const rows = (keyOf, label = (k) => k) => evaluateBy(ideas, keyOf, opts).map((r) => ({ ...r, key: label(r.key) }));
  const traded = ideas
    .map((i) => ({ i, r: netResult(i, opts) }))
    .filter((x) => x.r)
    .sort((a, b) => new Date(b.i.openedAt) - new Date(a.i.openedAt));
  return {
    generatedAt: new Date().toISOString(),
    period: { days: params.days, stocks: symbols.length },
    params: { days: params.days, riskAmount: opts.riskAmount, slippagePct: opts.slippagePct, exit: target ? 'target' : 'lock', target, steps: money.steps, exitMin },
    overall: evaluate(ideas, opts),
    bySetup: rows((i) => i.setup).sort((a, b) => b.totalNet - a.totalNet),
    bySide: rows((i) => i.side, (k) => (k === 'BUY' ? 'Buys' : 'Sells')),
    byHour: rows(hourOf),
    byExit: rows((i) => i.exit, (k) => EXIT_WORD[k] || k),
    firstTarget: targetTable(ideas),
    ...extra,
    recent: traded.slice(0, 15).map(({ i, r }) => ({ symbol: i.symbol, setup: i.setup, side: i.side, openedAt: i.openedAt, entry: i.entry, stopLoss: i.stopLoss, exit: EXIT_WORD[i.exit] || i.exit, exitPrice: i.exitPrice, qty: r.qty, net: r.net })),
  };
}

/**
 * The user's combinations and every check of the builder on its own, traded on the 50 stocks with the same exits and sizing as the scanner's
 * ideas. A share is read on its own 5-minute bars (own volume and VWAP), the breadth comes from all 50. Study-only extras: nothing here changes the scanner rows.
 */
async function comboStudy({ nifty1, history, symbols, params, money, opts, onProgress }) {
  const wanted = params.finderOnly ? [] : (params.combos || []).filter((c) => c.on !== false);
  const rank = params.rank !== false;
  const pairWanted = Boolean(params.pairFind || params.comboFind);
  if (!wanted.length && !rank && !pairWanted) return { combos: [], indicators: [], combosSkipped: [], pairs: null, comboFound: null };
  onProgress('Working out the 50-stock breadth');
  const stocks5 = Object.fromEntries(symbols.map((s) => [s, bars5Of(history[s])]));
  const timeline = aggregateCandles(nifty1, '5m');
  const breadth = breadthByTime(timeline, stocks5);
  const days = new Set([...new Set(nifty1.map((b) => DAY(b.time)))].sort((a, b) => a - b).slice(-params.days));
  const dayList = [...days].sort((a, b) => a - b);
  const midDay = dayList[Math.floor(dayList.length / 2)];

  const jobs = [
    ...wanted.map((combo) => ({ key: `combo:${combo.id}`, combo, label: `My combination: ${combo.name}`, text: describeCombo(combo), mine: true })),
    ...(rank ? CONDITIONS.map((cond) => ({ key: cond.key, combo: singleCombo(cond.key), cond })) : []),
  ];
  let have = null;
  // Trades every job's idea on every stock: { job key: ideas }. One read of each stock's chart serves all the jobs.
  const collect = async (list, what) => {
    const ideasBy = new Map(list.map((j) => [j.key, []]));
    for (const [n, symbol] of symbols.entries()) {
      onProgress(`${what} on ${symbol} (${n + 1}/${symbols.length})`);
      const c1 = history[symbol];
      const chart = shareChart(stocks5[symbol], { breadth });
      have ||= chart.have;
      const at = new Map(c1.map((b, i) => [b.time, i]));
      for (const job of list) {
        if ((job.cond && !usable(job.cond, chart.have)) || missingData(job.combo, chart.have).length) continue;
        for (const idea of shareIdeas(chart, job.combo, { symbol, exitMin: money.exitMin, days })) {
          const from = at.get(idea.time - 60);
          if (from == null) continue;
          ideasBy.get(job.key).push({ ...idea, ...followLive(c1, from, idea, undefined, money) });
        }
      }
      await yieldTurn();
    }
    return ideasBy;
  };
  const ideasBy = await collect(jobs, 'Trying the combinations and indicators');
  const summarize = (ideas) => {
    const all = evaluate(ideas, opts);
    const half = (pick) => evaluate(ideas.filter((i) => pick(DAY(Date.parse(i.openedAt) / 1000))), opts).totalNet;
    const side = (s) => {
      const r = evaluate(ideas.filter((i) => i.side === s), opts);
      return { trades: r.trades, net: r.totalNet };
    };
    return { ...all, buys: side('BUY'), sells: side('SELL'), halves: [half((d) => d < midDay), half((d) => d >= midDay)] };
  };
  const combos = [];
  const combosSkipped = [];
  for (const job of jobs.filter((j) => j.mine)) {
    const missing = have ? missingData(job.combo, have) : [];
    if (missing.length) {
      combosSkipped.push({ id: job.combo.id, name: job.combo.name, reason: `needs ${[...new Set(missing)].join(' and ')}, which this run did not have` });
      continue;
    }
    combos.push({ key: job.key, label: job.label, text: job.text, ...summarize(ideasBy.get(job.key)) });
  }
  const indicators = jobs
    .filter((j) => j.cond && (!have || usable(j.cond, have)))
    .map((j) => {
      const m = summarize(ideasBy.get(j.key));
      return { key: j.key, label: j.cond.label, group: j.cond.group, kind: j.cond.kind, text: j.cond.text, trades: m.trades, winRate: m.winRate, net: m.totalNet, avgNet: m.expectancy, calls: m.buys, puts: m.sells, halves: m.halves, verdict: verdictOf({ trades: m.trades, net: m.totalNet, halves: m.halves }) };
    })
    .sort((a, b) => b.net - a.net);
  let pairs = null;
  let comboFound = null;
  if (pairWanted) {
    const trainDay = dayList[Math.floor((dayList.length * 2) / 3)];
    const dayOfIdea = (i) => DAY(Date.parse(i.openedAt) / 1000);
    const part = (ideas) => {
      const r = evaluate(ideas, opts);
      return { trades: r.trades, net: r.totalNet, winRate: r.winRate };
    };
    const evaluateMany = async (lists) => {
      const pairJobs = lists.map((conds) => ({ key: conds.join('+'), combo: { id: conds.join('+'), name: conds.join('+'), conds, need: conds.length, window: 3 } }));
      const by = await collect(pairJobs, `Pair finder (${pairJobs.length} pairs)`);
      return lists.map((conds) => {
        const ideas = by.get(conds.join('+'));
        const all = summarize(ideas);
        return { conds, train: part(ideas.filter((i) => dayOfIdea(i) < trainDay)), test: part(ideas.filter((i) => dayOfIdea(i) >= trainDay)), all: { trades: all.trades, net: all.totalNet, winRate: all.winRate, calls: all.buys, puts: all.sells } };
      });
    };
    const common = { indicators, have: have || {}, studyDays: dayList.length, trainEnd: trainDay, evaluateMany };
    const { first, bases, missing } = pairStart(params.pairFirst, params.combos);
    if (params.pairFind) pairs = missing ? { skipped: 'that combination is no longer saved' } : await findPairs({ ...common, first, bases, depth: params.finderOnly ? params.pairDepth ?? 3 : 1, show: params.pairShow, goal: params.pairGoal === 'winrate' ? 'winrate' : 'profit' });
    if (params.comboFind) comboFound = await findCombos({ ...common, show: params.pairShow ?? undefined, goal: params.pairGoal === 'winrate' ? 'winrate' : 'profit' });
  }
  return { combos: combos.sort((a, b) => b.totalNet - a.totalNet), indicators, combosSkipped, pairs, comboFound };
}
