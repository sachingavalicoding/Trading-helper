import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { istParts } from '../market/marketHours.js';
import { TECHNIQUES, available, prepare, findSignals, turnoverSeries } from '../study/patterns.js';
import { breadthSeries, tradesFor } from '../study/optionsStudy.js';
import { buildChart, CONDITIONS, CONDITION_BY_KEY, usable } from '../combos/conditions.js';
import { entryTestOf } from '../options/signal.js';
import { comboSignals, describeCombo, heldConditions, holdsAt, missingData } from '../combos/combos.js';
import { summarize } from '../study/simulate.js';
import { halvesOf, verdictOf } from '../combos/verdict.js';
import { round2 } from '../utils/money.js';
import { badRequest } from '../utils/errors.js';

// The Combination Lab: one saved combination (or one pattern) traded over a stretch of days, every entry listed, and every other check tried
// added to it so the losing entries it would have skipped are visible. A look back at paper trades of one lot; nothing here places an order.

export const MAX_ADD = 3; // checks added at once
export const MAX_DAYS = 65;
const WARM_DAYS = 3; // days of candles before the range, so the chart's indicators have context
const SHOW_ROWS = 60;
const FIXES_PER_LOSER = 5;

const DAY = (t) => Math.floor((t + 19800) / 86400);
const dayKey = (t) => istParts(new Date(t * 1000)).dateKey;
const keyOf = (t) => `${t.entryTime}|${t.side}`;
const sum = (xs) => round2(xs.reduce((a, n) => a + n, 0));

/** What can be the starting point: the user's combinations (even switched off) and the chart patterns. */
export function lines(combos) {
  return {
    combos: combos.map((c) => ({ key: `combo:${c.id}`, label: c.name, text: describeCombo(c), off: c.on === false })),
    patterns: TECHNIQUES.filter((t) => t.key !== 'doubleBottomMid' && available(t, { breadth: true, flow: true })).map((t) => ({ key: `pattern:${t.key}`, label: t.label, text: t.text })),
  };
}

const lossRun = (trades) => {
  let run = 0;
  let max = 0;
  for (const t of [...trades].sort((a, b) => a.entryTime - b.entryTime)) {
    run = t.net <= 0 ? run + 1 : 0;
    max = Math.max(max, run);
  }
  return max;
};

function breakdown(trades, midTime) {
  const m = summarize(trades);
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let run = 0;
  const equity = sorted.map((t) => ({ time: t.exitTime, net: (run = round2(run + t.net)) }));
  const days = new Map();
  for (const t of trades) {
    const d = dayKey(t.entryTime);
    const x = days.get(d) || { day: d, trades: 0, wins: 0, net: 0 };
    x.trades += 1;
    x.wins += t.net > 0 ? 1 : 0;
    x.net = round2(x.net + t.net);
    days.set(d, x);
  }
  const halves = halvesOf(trades, midTime);
  return { ...m, halves, verdict: verdictOf({ trades: m.trades, net: m.net, halves }), longestLosingRun: lossRun(trades), equity, byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

/**
 * @param nifty1  index 1-minute candles, oldest first, a few days longer than the range
 * @param stocks5 { SYMBOL: 5-minute candles } or null
 * @param params  as the options study (`prices` and `mixPrices` choose real or estimated premiums)
 * @param base    'combo:<id>' or 'pattern:<key>'
 * @param add     check keys added to the base (all must hold), at most MAX_ADD
 */
export function analyzeLab({ nifty1, stocks5 = null, params, base, from = null, to = null, days = 22 }) {
  const complete = to ? nifty1.filter((b) => dayKey(b.time) <= to) : nifty1;
  const allDays = [...new Set(complete.map((b) => DAY(b.time)))].sort((a, b) => a - b);
  const dayNo = (key) => Date.parse(`${key}T00:00:00Z`) / 86400000;
  const studyDays = from ? allDays.filter((d) => d >= dayNo(from)) : allDays.slice(-days);
  if (!studyDays.length) throw badRequest('No saved candles between those dates. Press Download in Research > Saved data, or pick other dates.', 'NO_DATA');
  if (studyDays.length > MAX_DAYS) throw badRequest(`Pick at most ${MAX_DAYS} trading days (that range has ${studyDays.length}).`, 'VALIDATION');
  const fromTime = complete.find((b) => DAY(b.time) === studyDays[0]).time;
  const midTime = complete.find((b) => DAY(b.time) === studyDays[Math.floor(studyDays.length / 2)]).time;
  const byTime = new Map(complete.map((b, i) => [b.time, i]));
  let bars5 = aggregateCandles(complete, '5m');
  if (bars5.length && bars5.at(-1).time + 300 > complete.at(-1).time + 60) bars5 = bars5.slice(0, -1);
  const breadth = breadthSeries(bars5, stocks5);
  const flow = turnoverSeries(bars5, stocks5);
  const prep = prepare(bars5, breadth, flow);
  const chart = buildChart(bars5, { breadth, flow, prep });
  const inRange = (s) => s.time - 300 >= fromTime;

  const [kind, id] = String(base).split(/:(.*)/s);
  let name;
  let conds = [];
  let text;
  let signalsWith;
  if (kind === 'combo') {
    const combo = (params.combos || []).find((c) => c.id === id);
    if (!combo) throw badRequest('That combination is not saved.', 'NOT_FOUND');
    const missing = missingData(combo, chart.have);
    if (missing.length) throw badRequest(`That combination needs ${[...new Set(missing)].join(' and ')}, which is not saved.`, 'NO_DATA');
    ({ name, conds } = combo);
    text = describeCombo(combo);
    signalsWith = (extra) => comboSignals(chart, extra.length ? { ...combo, also: extra } : combo, { when: entryTestOf(params) }).filter(inRange);
  } else if (kind === 'pattern') {
    const t = TECHNIQUES.find((x) => x.key === id && available(x, { breadth: Boolean(breadth), flow: Boolean(flow) }));
    if (!t) throw badRequest('That pattern is not available on this data.', 'NOT_FOUND');
    name = t.label;
    text = t.text;
    const fired = findSignals(prep, { only: [id], when: entryTestOf(params) }).filter(inRange);
    signalsWith = (extra) => fired.filter((s) => extra.every((k) => holdsAt(chart, k, s.side === 'CE' ? 1 : -1, s.i)));
  } else throw badRequest('Pick a combination or a pattern.', 'VALIDATION');

  const traded = (extra) => {
    const signals = signalsWith(extra);
    return { signals, trades: tradesFor(signals, { c1: complete, byTime, params }).trades };
  };
  const baseRun = traded([]);
  const baseSignal = new Map(baseRun.signals.map((s) => [`${s.time}|${s.side}`, s]));
  const baseKeys = new Set(baseRun.trades.map(keyOf));
  const baseNet = sum(baseRun.trades.map((t) => t.net));

  // every other check, added on its own: what it would have skipped and what it would have added
  const rows = [];
  for (const cond of CONDITIONS) {
    if (conds.includes(cond.key) || !usable(cond, chart.have) || cond.needs === 'news') continue;
    const { trades } = traded([cond.key]);
    const keep = new Set(trades.map(keyOf));
    const removed = baseRun.trades.filter((t) => !keep.has(keyOf(t)));
    const added = trades.filter((t) => !baseKeys.has(keyOf(t)));
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
      _skips: new Set(removed.map(keyOf)),
    });
  }
  rows.sort((a, b) => b.gain - a.gain);
  return { kind, conds, chart, params, traded, baseRun, baseSignal, baseKeys, baseNet, rows, complete, bars5, studyDays, fromTime, midTime, base, name, text };
}

/** The part that depends on the picked checks: which entries they skip, the new result, the day list. Cheap, so a tap on a check does not redo the ranking. */
export function presentLab(ctx, add = []) {
  const { kind, conds, chart, params, traded, baseRun, baseSignal, baseKeys, rows, complete, bars5, studyDays, fromTime, midTime, base, name, text } = ctx;
  const cleanAdd = [...new Set(add)].filter((k) => CONDITION_BY_KEY.has(k) && !conds.includes(k) && usable(CONDITION_BY_KEY.get(k), chart.have)).slice(0, MAX_ADD);

  // the entry list: every entry of the base, marked kept or removed once checks are added, and the entries the new combination adds
  const sel = cleanAdd.length ? traded(cleanAdd) : null;
  const selKeys = sel ? new Set(sel.trades.map(keyOf)) : null;
  const heldAt = (s, d) => (kind === 'combo' ? heldConditions(chart, { conds }, d, s.i) : []);
  const describe = (t, status) => {
    const s = baseSignal.get(keyOf(t)) ?? sel?.signals.find((x) => `${x.time}|${x.side}` === keyOf(t));
    const loser = t.net <= 0;
    const fixes =
      loser && status !== 'added'
        ? rows
            .filter((r) => r._skips.has(keyOf(t)))
            .slice(0, FIXES_PER_LOSER)
            .map((r) => ({ key: r.key, label: r.label, gain: r.gain, winnersLost: r.removed.winners, winnersLostNet: r.removed.winnersNet, losersRemoved: r.removed.losers, verdict: r.verdict }))
        : [];
    const d = t.side === 'CE' ? 1 : -1;
    return {
      id: keyOf(t),
      day: dayKey(t.entryTime),
      status,
      side: t.side,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      entrySpot: t.entrySpot,
      exitSpot: t.exitSpot,
      stop: t.stop,
      strike: t.strike,
      expiry: t.expiry,
      lots: t.lots,
      entryPremium: t.entryPremium,
      exitPremium: round2(Math.max(0, t.entryPremium + t.gross / ((t.lots || 1) * (params.lotSize || 1)))),
      gross: t.gross,
      charges: t.charges,
      net: t.net,
      reason: t.reason,
      minutes: t.minutes,
      best: t.best,
      worst: t.worst,
      priced: t.priced,
      note: s?.note,
      why: s && kind === 'combo' ? heldAt(s, d) : [],
      fixes,
    };
  };
  const entries = [
    ...baseRun.trades.map((t) => describe(t, !selKeys ? 'kept' : selKeys.has(keyOf(t)) ? 'kept' : 'removed')),
    ...(sel ? sel.trades.filter((t) => !baseKeys.has(keyOf(t))).map((t) => describe(t, 'added')) : []),
  ].sort((a, b) => a.entryTime - b.entryTime);

  // every trading day of the period, with how the index moved and which entries came on it (a day with none is listed too)
  const book = params.prices;
  const byDay = new Map();
  for (const b of bars5.filter((x) => x.time >= fromTime)) {
    const d = dayKey(b.time);
    const x = byDay.get(d);
    if (!x) byDay.set(d, { day: d, open: b.open, high: b.high, low: b.low, close: b.close });
    else Object.assign(x, { high: Math.max(x.high, b.high), low: Math.min(x.low, b.low), close: b.close });
  }
  const dayList = [...byDay.values()].map((x) => {
    const list = entries.filter((e) => e.day === x.day);
    const live = list.filter((e) => e.status !== 'removed');
    return { ...x, changePts: round2(x.close - x.open), rangePts: round2(x.high - x.low), entries: list.map((e) => e.id), trades: live.length, net: round2(live.reduce((a, e) => a + e.net, 0)), realPrices: Boolean(book?.hasDay?.(x.day)) };
  });
  const first = studyDays[0];
  const lastDay = dayKey(complete.at(-1).time);
  const candles = bars5.filter((b) => DAY(b.time) >= first - WARM_DAYS - 2).map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
  const priced = baseRun.trades.filter((t) => t.priced === 'real').length;
  return {
    period: { from: dayKey(fromTime), to: lastDay, days: studyDays.length },
    base: { key: base, name, conds, labels: conds.map((k) => CONDITION_BY_KEY.get(k)?.label ?? k), text, signals: baseRun.signals.length },
    add: cleanAdd,
    pricing: { real: priced, estimated: baseRun.trades.length - priced },
    stats: breakdown(baseRun.trades, midTime),
    withAdd: sel ? { labels: cleanAdd.map((k) => CONDITION_BY_KEY.get(k).label), ...breakdown(sel.trades, midTime) } : null,
    entries,
    dayList,
    addons: rows.slice(0, SHOW_ROWS).map(({ _skips, ...r }) => r),
    candles,
    rangeFrom: fromTime,
  };
}

/** Both steps at once. */
export const runLab = (opts) => presentLab(analyzeLab(opts), opts.add);
