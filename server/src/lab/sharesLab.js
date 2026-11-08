import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { istParts } from '../market/marketHours.js';
import { CONDITIONS, CONDITION_BY_KEY, usable } from '../combos/conditions.js';
import { describeCombo, heldConditions, holdsAt, missingData, normalizeExits, normalizeOrder, singleCombo } from '../combos/combos.js';
import { bars5Of, breadthByTime, comboMoney, shareChart, shareIdeas } from '../combos/shares.js';
import { followLive } from '../scanner/replay.js';
import { netResult } from '../scanner/backtest.js';
import { roundTripCharges } from '../services/charges.js';
import { summarize } from '../study/simulate.js';
import { halvesOf, verdictOf } from '../combos/verdict.js';
import { round2 } from '../utils/money.js';
import { badRequest } from '../utils/errors.js';
import { MAX_ADD, MAX_DAYS } from './lab.js';

// The Combination Lab for shares: one share combination (or one check) traded on the Nifty 50 stocks over a stretch of days, the way the
// live auto trader would (one trade per stock at a time, at most `maxOpen` open together, the daily loss limit, sized to the stop, the
// charges checks), every entry listed, and every other check tried on top so the losing entries it would have skipped are visible.
// A look back on paper; nothing here places an order. "CE" is a buy and "PE" a short sale, as everywhere in the share combinations.

const SHOW_ROWS = 60;
const FIXES_PER_LOSER = 5;
const MIN_PROFIT_TO_CHARGES = 3; // the auto trader's own checks (autoTrader.js)
const MAX_CHARGES_OF_RISK = 0.25;
const TARGET1_R = 1.5;

const DAY = (t) => Math.floor((t + 19800) / 86400);
const dayKey = (t) => istParts(new Date(t * 1000)).dateKey;
const sum = (xs) => round2(xs.reduce((a, n) => a + n, 0));

/** What can be the starting point for shares: the user's share combinations (even switched off) and every check on its own. */
export function shareLines(combos) {
  return {
    combos: combos.map((c) => ({ key: `combo:${c.id}`, label: c.name, text: describeCombo(c), off: c.on === false })),
    checks: CONDITIONS.filter((c) => c.needs !== 'news').map((c) => ({ key: `check:${c.key}`, label: c.label, group: c.group })),
  };
}

/** The order settings a test may change (side, own order settings, own profit ladder), cleaned like a saved combination. */
export function withOrder(combo, edit) {
  if (!edit) return combo;
  const out = { ...combo };
  if ('side' in edit) {
    if (edit.side === 'CE' || edit.side === 'PE') out.side = edit.side;
    else delete out.side;
  }
  if ('order' in edit) {
    const order = normalizeOrder(edit.order);
    if (order) out.order = order;
    else delete out.order;
  }
  if ('steps' in edit) {
    // shares use only the profit ladder of a combination's own exits: null = the Account ladder, [] = no lock
    const exits = edit.steps == null ? undefined : normalizeExits({ steps: edit.steps });
    if (exits) out.exits = { steps: exits.steps };
    else if (Array.isArray(edit.steps) && !edit.steps.length) out.exits = { steps: [] };
    else delete out.exits;
  }
  return out;
}

const minutesOf = (t) => istParts(new Date(t * 1000)).minutes;

/**
 * The live auto trader's limits over a list of possible trades, oldest first: one trade per stock at a time, at most `maxOpen` open at once,
 * no new trade once the day's closed trades have lost `dailyLoss`. Returns the trades taken and how many each limit stopped.
 */
export function liveRun(list, { maxOpen = 2, dailyLoss = 0 } = {}) {
  const sorted = [...list].sort((a, b) => a.entryTime - b.entryTime || a.symbol.localeCompare(b.symbol));
  const taken = [];
  const blocked = { busy: 0, sameStock: 0, dailyLoss: 0 };
  let open = [];
  for (const t of sorted) {
    open = open.filter((o) => o.exitTime > t.entryTime);
    if (open.some((o) => o.symbol === t.symbol)) {
      blocked.sameStock += 1;
      continue;
    }
    if (open.length >= maxOpen) {
      blocked.busy += 1;
      continue;
    }
    if (dailyLoss > 0) {
      const day = DAY(t.entryTime);
      const closed = sum(taken.filter((x) => DAY(x.entryTime) === day && x.exitTime <= t.entryTime).map((x) => x.net));
      if (closed <= -dailyLoss) {
        blocked.dailyLoss += 1;
        continue;
      }
    }
    taken.push(t);
    open.push(t);
  }
  return { trades: taken, blocked };
}

function breakdown(trades, midTime) {
  const m = summarize(trades);
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let run = 0;
  const equity = sorted.map((t) => ({ time: t.exitTime, net: (run = round2(run + t.net)) }));
  const days = new Map();
  const stocks = new Map();
  for (const t of trades) {
    const d = dayKey(t.entryTime);
    const x = days.get(d) || { day: d, trades: 0, wins: 0, net: 0 };
    x.trades += 1;
    x.wins += t.net > 0 ? 1 : 0;
    x.net = round2(x.net + t.net);
    days.set(d, x);
    const s = stocks.get(t.symbol) || { symbol: t.symbol, trades: 0, wins: 0, net: 0 };
    s.trades += 1;
    s.wins += t.net > 0 ? 1 : 0;
    s.net = round2(s.net + t.net);
    stocks.set(t.symbol, s);
  }
  let lossRun = 0;
  let longest = 0;
  for (const t of [...trades].sort((a, b) => a.entryTime - b.entryTime)) {
    lossRun = t.net <= 0 ? lossRun + 1 : 0;
    longest = Math.max(longest, lossRun);
  }
  const halves = halvesOf(trades, midTime);
  return {
    ...m,
    halves,
    verdict: verdictOf({ trades: m.trades, net: m.net, halves }),
    longestLosingRun: longest,
    equity,
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    byStock: [...stocks.values()].sort((a, b) => b.net - a.net),
    charges: sum(trades.map((t) => t.charges)),
    money: trades.length ? Math.round(Math.max(...trades.map((t) => t.amount))) : 0,
  };
}

/**
 * @param nifty1   Nifty 1-minute candles (the day list and the 50-stock breadth timeline), a few days longer than the range
 * @param history  { SYMBOL: 1-minute candles }
 * @param params   { combos, riskAmount, maxAmount, maxShares, slippagePct, steps, target, exitMin, maxOpen, dailyLoss }
 * @param base     'combo:<id>' or 'check:<key>'
 * @param edit     order settings to try in place of the saved ones: { side, order, steps } (see withOrder)
 */
export function analyzeSharesLab({ nifty1, history, params, base, from = null, to = null, days = 22, edit = null }) {
  const cut = (c) => (to ? c.filter((b) => dayKey(b.time) <= to) : c);
  const index1 = cut(nifty1);
  const allDays = [...new Set(index1.map((b) => DAY(b.time)))].sort((a, b) => a - b);
  const dayNo = (key) => Date.parse(`${key}T00:00:00Z`) / 86400000;
  const studyDays = from ? allDays.filter((d) => d >= dayNo(from)) : allDays.slice(-days);
  if (!studyDays.length) throw badRequest('No saved candles between those dates. Press Download in Research > Saved data, or pick other dates.', 'NO_DATA');
  if (studyDays.length > MAX_DAYS) throw badRequest(`Pick at most ${MAX_DAYS} trading days (that range has ${studyDays.length}).`, 'VALIDATION');
  const daySet = new Set(studyDays);
  const fromTime = index1.find((b) => DAY(b.time) === studyDays[0]).time;
  const midTime = index1.find((b) => DAY(b.time) === studyDays[Math.floor(studyDays.length / 2)]).time;

  const [kind, id] = String(base).split(/:(.*)/s);
  let saved;
  if (kind === 'combo') {
    saved = (params.combos || []).find((c) => c.id === id);
    if (!saved) throw badRequest('That share combination is not saved.', 'NOT_FOUND');
  } else if (kind === 'check') {
    const cond = CONDITION_BY_KEY.get(id);
    if (!cond || cond.needs === 'news') throw badRequest('That check cannot be tested on past candles.', 'NOT_FOUND');
    saved = singleCombo(id);
  } else throw badRequest('Pick a share combination or a check.', 'VALIDATION');
  const combo = withOrder(saved, edit);
  const conds = [...combo.conds, ...(combo.also || [])];
  const money = comboMoney(combo, { riskAmount: params.riskAmount || 1000, slippagePct: params.slippagePct ?? 0.05, maxAmount: params.maxAmount || 0, maxShares: params.maxShares || 0, steps: params.steps ?? [], target: params.target || 0, exitMin: params.exitMin || 15 * 60 + 15 });

  const c1s = {};
  const stocks5 = {};
  for (const [symbol, c] of Object.entries(history)) {
    const c1 = cut(c || []);
    if (c1.length > 100) {
      c1s[symbol] = c1;
      stocks5[symbol] = bars5Of(c1);
    }
  }
  if (!Object.keys(c1s).length) throw badRequest('No share candles are saved. Log in to Upstox and press Download in Research > Saved data.', 'NO_DATA');
  const breadth = breadthByTime(aggregateCandles(index1, '5m'), stocks5);

  // every entry the combination gives on every stock, traded with the live exits and sized like live; the live limits come after
  const charts = {};
  const ideas = [];
  const skipped = { size: 0, charges: 0, missing: 0 };
  let have = null;
  for (const symbol of Object.keys(c1s).sort()) {
    const chart = shareChart(stocks5[symbol], { breadth });
    have ||= chart.have;
    if (missingData(combo, chart.have).length) {
      skipped.missing += 1;
      continue;
    }
    charts[symbol] = chart;
    const c1 = c1s[symbol];
    const at = new Map(c1.map((b, i) => [b.time, i]));
    for (const idea of shareIdeas(chart, combo, { symbol, exitMin: money.exitMin, days: daySet })) {
      const fromI = at.get(idea.time - 60);
      if (fromI == null) continue;
      const out = followLive(c1, fromI, idea, undefined, money);
      const r = netResult({ ...idea, ...out }, money);
      if (!r || r.qty < 1) {
        skipped.size += 1;
        continue;
      }
      const risk = Math.abs(idea.entry - idea.stopLoss);
      const charges = roundTripCharges({ qty: r.qty, price: idea.entry });
      if ((risk * r.qty > 0 && charges > MAX_CHARGES_OF_RISK * risk * r.qty) || r.qty * TARGET1_R * risk < MIN_PROFIT_TO_CHARGES * charges) {
        skipped.charges += 1; // the auto trader skips a trade whose charges eat too much of the risk or of the first target
        continue;
      }
      const exitTime = (out.exitTime ?? idea.time) + 60;
      ideas.push({
        id: `${symbol}|${idea.time}|${idea.side}`,
        symbol,
        side: idea.side === 'BUY' ? 'CE' : 'PE',
        i: idea.i,
        entryTime: idea.time,
        exitTime,
        minutes: Math.max(1, Math.round((exitTime - idea.time) / 60)),
        entry: idea.entry,
        stopLoss: idea.stopLoss,
        exitPrice: out.exitPrice,
        qty: r.qty,
        amount: round2(r.qty * idea.entry),
        risk: round2(r.qty * risk),
        gross: r.gross,
        charges: r.charges,
        net: r.net,
        reason: out.exit,
      });
    }
  }
  if (kind === 'combo' && !Object.keys(charts).length) {
    const missing = have ? missingData(combo, have) : [];
    throw badRequest(`That combination needs ${[...new Set(missing)].join(' and ') || 'data'} which is not saved.`, 'NO_DATA');
  }
  const limits = { maxOpen: params.maxOpen || 2, dailyLoss: params.dailyLoss || 0 };
  const held = (t, key) => holdsAt(charts[t.symbol], key, t.side === 'CE' ? 1 : -1, t.i, combo.window);
  const traded = (extra) => liveRun(extra.length ? ideas.filter((t) => extra.every((k) => held(t, k))) : ideas, limits);
  const baseRun = traded([]);
  const baseKeys = new Set(baseRun.trades.map((t) => t.id));
  const baseNet = sum(baseRun.trades.map((t) => t.net));

  // every other check, added on its own: which taken entries it would have skipped (and which it lets in, once a slot is free)
  const rows = [];
  for (const cond of CONDITIONS) {
    if (conds.includes(cond.key) || !have || !usable(cond, have) || cond.needs === 'news') continue;
    const { trades } = traded([cond.key]);
    const keep = new Set(trades.map((t) => t.id));
    const removed = baseRun.trades.filter((t) => !keep.has(t.id));
    const added = trades.filter((t) => !baseKeys.has(t.id));
    if (!removed.length && !added.length) continue;
    const m = summarize(trades);
    const halves = halvesOf(trades, midTime);
    const losers = removed.filter((t) => t.net <= 0);
    const winners = removed.filter((t) => t.net > 0);
    rows.push({
      key: cond.key,
      label: cond.label,
      group: cond.group,
      text: cond.text,
      trades: m.trades,
      wins: m.wins,
      winRate: m.winRate,
      net: m.net,
      maxDrawdown: m.maxDrawdown,
      gain: round2(m.net - baseNet),
      halves,
      verdict: verdictOf({ trades: m.trades, net: m.net, halves }),
      removed: { trades: removed.length, losers: losers.length, losersNet: sum(losers.map((t) => t.net)), winners: winners.length, winnersNet: sum(winners.map((t) => t.net)) },
      added: { trades: added.length, net: sum(added.map((t) => t.net)) },
      _skips: new Set(removed.map((t) => t.id)),
    });
  }
  rows.sort((a, b) => b.gain - a.gain);
  return { kind, combo, saved, conds, charts, have, money, limits, ideas, traded, baseRun, baseKeys, rows, index1, studyDays, fromTime, midTime, base, skipped };
}

/** The part that depends on the picked checks. Cheap, so a tap on a check does not redo the ranking. */
export function presentSharesLab(ctx, add = []) {
  const { kind, combo, saved, conds, charts, have, money, limits, ideas, traded, baseRun, baseKeys, rows, index1, studyDays, fromTime, midTime, base, skipped } = ctx;
  const cleanAdd = [...new Set(add)].filter((k) => CONDITION_BY_KEY.has(k) && !conds.includes(k) && have && usable(CONDITION_BY_KEY.get(k), have)).slice(0, MAX_ADD);
  const sel = cleanAdd.length ? traded(cleanAdd) : null;
  const selKeys = sel ? new Set(sel.trades.map((t) => t.id)) : null;
  const describe = (t, status) => {
    const fixes =
      t.net <= 0 && status !== 'added'
        ? rows
            .filter((r) => r._skips.has(t.id))
            .slice(0, FIXES_PER_LOSER)
            .map((r) => ({ key: r.key, label: r.label, gain: r.gain, winnersLost: r.removed.winners, winnersLostNet: r.removed.winnersNet, losersRemoved: r.removed.losers, verdict: r.verdict }))
        : [];
    const { i, ...rest } = t;
    return { ...rest, day: dayKey(t.entryTime), status, why: kind === 'combo' ? heldConditions(charts[t.symbol], combo, t.side === 'CE' ? 1 : -1, i) : [], fixes };
  };
  const entries = [
    ...baseRun.trades.map((t) => describe(t, !selKeys || selKeys.has(t.id) ? 'kept' : 'removed')),
    ...(sel ? sel.trades.filter((t) => !baseKeys.has(t.id)).map((t) => describe(t, 'added')) : []),
  ].sort((a, b) => a.entryTime - b.entryTime);

  // every trading day, with how the Nifty moved and which entries came on it
  const byDay = new Map();
  for (const b of index1.filter((x) => x.time >= fromTime)) {
    const d = dayKey(b.time);
    const x = byDay.get(d);
    if (!x) byDay.set(d, { day: d, open: b.open, high: b.high, low: b.low, close: b.close });
    else Object.assign(x, { high: Math.max(x.high, b.high), low: Math.min(x.low, b.low), close: b.close });
  }
  const dayList = [...byDay.values()].map((x) => {
    const list = entries.filter((e) => e.day === x.day);
    const live = list.filter((e) => e.status !== 'removed');
    return { ...x, changePts: round2(x.close - x.open), rangePts: round2(x.high - x.low), entries: list.map((e) => e.id), trades: live.length, net: round2(live.reduce((a, e) => a + e.net, 0)) };
  });
  return {
    segment: 'shares',
    period: { from: dayKey(fromTime), to: dayKey(index1.at(-1).time), days: studyDays.length, stocks: Object.keys(charts).length },
    base: { key: base, name: kind === 'combo' ? saved.name : CONDITION_BY_KEY.get(conds[0])?.label, conds, labels: conds.map((k) => CONDITION_BY_KEY.get(k)?.label ?? k), text: describeCombo(combo), signals: ideas.length },
    // the order settings this run used, and what came from where, so the page can show and edit them
    orders: {
      side: combo.side ?? null,
      order: combo.order ?? null,
      steps: combo.exits && Array.isArray(combo.exits.steps) ? combo.exits.steps : null,
      used: { riskAmount: money.riskAmount, maxAmount: money.maxAmount, steps: money.steps, target: money.target, exitMin: money.exitMin, stopPct: combo.order?.stopPct ?? 0, maxOpen: limits.maxOpen, dailyLoss: round2(limits.dailyLoss) },
      edited: JSON.stringify([saved.side ?? null, saved.order ?? null, saved.exits?.steps ?? null]) !== JSON.stringify([combo.side ?? null, combo.order ?? null, combo.exits?.steps ?? null]),
    },
    add: cleanAdd,
    stats: breakdown(baseRun.trades, midTime),
    blocked: { ...baseRun.blocked, ...skipped },
    withAdd: sel ? { labels: cleanAdd.map((k) => CONDITION_BY_KEY.get(k).label), ...breakdown(sel.trades, midTime) } : null,
    entries,
    dayList,
    addons: rows.slice(0, SHOW_ROWS).map(({ _skips, ...r }) => r),
  };
}

/** One stock's 5-minute bars on one day (plus the day before, for context), for the chart of one entry. */
export function sharesDayBars(history, symbol, day) {
  const c1 = history?.[symbol];
  if (!c1?.length) return [];
  const bars = aggregateCandles(c1, '5m');
  const at = bars.findIndex((b) => dayKey(b.time) === day);
  if (at < 0) return [];
  const end = bars.findLastIndex((b) => dayKey(b.time) === day);
  return bars.slice(Math.max(0, at - 75), end + 1).map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }));
}

/** Both steps at once. */
export const runSharesLab = (opts) => presentSharesLab(analyzeSharesLab(opts), opts.add);
