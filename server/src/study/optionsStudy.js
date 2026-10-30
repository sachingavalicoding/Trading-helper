import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { istParts } from '../market/marketHours.js';
import { readNifty, FIRST_ENTRY_MIN, LAST_ENTRY_MIN } from '../options/signal.js';
import { round2 } from '../utils/money.js';
import { TECHNIQUES, available, prepare, findSignals, turnoverSeries, ruleStop, MIN_STOP_ATR, MAX_STOP_ATR } from './patterns.js';
import { simulateTrade, summarize } from './simulate.js';
import { CONDITIONS, CONDITION_BY_KEY, buildChart, usable } from '../combos/conditions.js';
import { comboSignals, singleCombo, missingData, describeCombo } from '../combos/combos.js';
import { verdictOf, halvesOf } from '../combos/verdict.js';
import { runResearch } from './research.js';
import { comboStopRule } from '../combos/combos.js';
import { findPairs, findCombos, pairStart } from './pairFinder.js';

// The options study: what each way of reading the Nifty chart would have earned on the last few weeks, as paper trades of one lot.
// It reads history and changes nothing: the live trading rules are not touched by it.

const DAY = (t) => Math.floor((t + 19800) / 86400);
const dayKey = (t) => istParts(new Date(t * 1000)).dateKey;
const MAX_PER_DAY = 3; // the live options trader also stops after 3 entries a day
const BOT_KEY = 'bot';
const SCORE_PATTERNS = ['breakout', 'pullback', 'engulfing']; // the patterns that held up in the 30-day study
const SCORE_FLOORS = [60, 70, 80];
const AGREE_PATTERNS = ['breakout', 'engulfing', 'momentumBar']; // the ones that made money in the 62-day study
const AGREE_LABEL = 'Breakout, Engulfing and Strong momentum bar';
// Breakout + Engulfing with the stop worked out from the entry instead of the chart level, to see what the far-stop skips and the room cost or gain.
const STOP_RULES = [
  { key: 'beCap20', rule: { mode: 'cap', k: 2 }, label: 'Breakout + Engulfing, far stops pulled in to 2 ATR', text: 'The same two patterns, but when the chart stop is further than 2 ATR from the entry the stop is put at 2 ATR instead of skipping the trade. A nearer chart stop stays.' },
  { key: 'beAtr10', rule: { mode: 'atr', k: 1 }, label: 'Breakout + Engulfing, stop 1 ATR from entry', text: 'The same two patterns with the stop always 1 ATR from the entry (about the size of one 5-minute swing), whatever the chart level is.' },
  { key: 'beAtr15', rule: { mode: 'atr', k: 1.5 }, label: 'Breakout + Engulfing, stop 1.5 ATR from entry', text: 'The same two patterns with the stop always 1.5 ATR from the entry.' },
  { key: 'beAtr20', rule: { mode: 'atr', k: 2 }, label: 'Breakout + Engulfing, stop 2 ATR from entry', text: 'The same two patterns with the stop always 2 ATR from the entry.' },
  ...[20, 30, 40].map((points) => ({ key: `beFix${points}`, rule: { mode: 'fixed', points }, label: `Breakout + Engulfing, fixed stop ${points} points`, text: `The same two patterns with the stop always ${points} Nifty points from the entry, whatever the chart level is.` })),
];
const LABELS = {
  ...Object.fromEntries(TECHNIQUES.map((t) => [t.key, t])),
  confluence: { key: 'confluence', label: 'Two or more agree', text: 'Two different techniques give the same direction within 15 minutes. Stop at the nearest of their stops.' },
  agree2: { key: 'agree2', label: 'Pattern score: any 2 of 3 agree', text: `${AGREE_LABEL}: a trade is taken only when at least 2 of them give the same direction within 15 minutes (a score of 2 out of 3). Stop at the nearest of their stops.` },
  agree3: { key: 'agree3', label: 'Pattern score: all 3 agree', text: `${AGREE_LABEL}: a trade is taken only when all 3 give the same direction within 15 minutes (3 out of 3). Rare, so expect few trades.` },
  botFiltered: { key: 'botFiltered', label: 'Current bot, calls only in an up-day', text: 'The current bot, but a call is taken only when Nifty is above yesterday close and above the day average. Puts are unchanged.' },
  breakoutMid: { key: 'breakoutMid', label: 'Breakout, tighter stop', text: 'The same breakout of the last hour, but the stop sits half way between the entry and the last-6-bar extreme, so far more of them fit the loss limit. It gives up some room.' },
  breakoutEngulf: { key: 'breakoutEngulf', label: 'Breakout + Engulfing together', text: 'Breakout of the last hour and the engulfing candle, taken by one bot: one trade at a time and at most 3 a day, as live.' },
  patternsAll: { key: 'patternsAll', label: 'Patterns alone (Breakout, Pullback, Engulfing)', text: 'Any of the three patterns that worked, taken as soon as it appears, with no score check. The baseline for the three tests below.' },
  ...Object.fromEntries(SCORE_FLOORS.map((floor) => [`patternScore${floor}`, { key: `patternScore${floor}`, label: `Patterns, score ${floor}+ agrees`, text: `The same three patterns, but only when the live score for that side is also at least ${floor}. The pattern decides, the score confirms.` }])),
  ...Object.fromEntries(STOP_RULES.map((r) => [r.key, r])),
  [BOT_KEY]: { key: BOT_KEY, label: 'Current bot (all checks)', text: 'What the live options trader does today: every chart check must agree and the score must reach the minimum. Shown to compare the others against.' },
};

const EXTRA = new Set(TECHNIQUES.filter((t) => t.extra).map((t) => t.key)); // added later: left out of the "together" rows so those keep their meaning

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

/** Share of the 50 stocks above yesterday's close at the end of each 5-minute Nifty bar; null where too few stocks have data. */
export function breadthSeries(bars5, stocks5) {
  const lists = Object.values(stocks5 || {}).filter((c) => c && c.length > 10);
  if (lists.length < 30) return null;
  const prepared = lists.map((candles) => {
    const lastOfDay = new Map();
    for (const c of candles) lastOfDay.set(DAY(c.time), c.close);
    return { candles, lastOfDay, days: [...lastOfDay.keys()].sort((a, b) => a - b), p: 0 };
  });
  return bars5.map((bar) => {
    const end = bar.time + 300;
    const day = DAY(bar.time);
    let up = 0;
    let count = 0;
    for (const s of prepared) {
      while (s.p + 1 < s.candles.length && s.candles[s.p + 1].time + 300 <= end) s.p += 1;
      const c = s.candles[s.p];
      if (!c || DAY(c.time) !== day) continue;
      const prevDay = s.days.filter((d) => d < day).at(-1);
      if (prevDay == null) continue;
      count += 1;
      if (c.close > s.lastOfDay.get(prevDay)) up += 1;
    }
    return count >= 30 ? up / count : null;
  });
}

/** Does it pay to follow the 50 stocks? When most of them are on one side, how far did Nifty go over the next 30 and 60 minutes. */
export function breadthStudy(bars5, breadth, fromTime) {
  if (!breadth) return [];
  const rows = [];
  for (const th of [0.6, 0.7, 0.8]) {
    for (const d of [-1, 1]) {
      const move30 = [];
      const move60 = [];
      let armed = true;
      let lastDay = null;
      for (let i = 0; i < bars5.length; i++) {
        const b = bars5[i];
        const share = breadth[i] == null ? null : d > 0 ? breadth[i] : 1 - breadth[i];
        const day = DAY(b.time);
        if (day !== lastDay) {
          lastDay = day;
          armed = true;
        }
        if (share == null) continue;
        if (share < th - 0.1) armed = true;
        const { minutes } = istParts(new Date((b.time + 300) * 1000));
        if (!armed || share < th || b.time < fromTime || minutes < FIRST_ENTRY_MIN || minutes >= LAST_ENTRY_MIN) continue;
        armed = false;
        const at = (k) => (i + k < bars5.length && DAY(bars5[i + k].time) === day ? bars5[i + k].close : null);
        const a6 = at(6);
        const a12 = at(12);
        if (a6 != null) move30.push(d * (a6 - b.close));
        if (a12 != null) move60.push(d * (a12 - b.close));
      }
      const avg = (xs) => (xs.length ? round2(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
      const hit = (xs) => (xs.length ? Math.round((xs.filter((x) => x > 0).length / xs.length) * 100) : null);
      rows.push({ share: Math.round(th * 100), side: d < 0 ? 'down' : 'up', episodes: move30.length, avg30: avg(move30), hit30: hit(move30), avg60: avg(move60), hit60: hit(move60) });
    }
  }
  return rows;
}

const lite = (xs) => {
  const m = summarize(xs);
  return { trades: m.trades, winRate: m.winRate, net: m.net, avgNet: m.avgNet, avgWin: m.avgWin, avgLoss: m.avgLoss };
};

/** The current bot's trades cut three ways: by what triggered the entry, by its score, and by call or put. */
export function botBreakdown(trades) {
  const by = (keyOf) => {
    const groups = new Map();
    for (const t of trades) {
      const k = keyOf(t);
      groups.set(k, [...(groups.get(k) || []), t]);
    }
    return [...groups.entries()].map(([key, xs]) => ({ key, ...lite(xs) })).sort((a, b) => b.net - a.net);
  };
  const band = (score) => (score >= 90 ? '90 and above' : score >= 85 ? '85 to 89' : '80 to 84');
  return { byTrigger: by((t) => t.tag || 'no trigger'), byScore: by((t) => band(t.score ?? 0)), bySide: by((t) => (t.side === 'CE' ? 'Calls' : 'Puts')) };
}

function confluenceSignals(signals, { min = 2, key = 'confluence' } = {}) {
  const out = [];
  const lastAt = { CE: -99, PE: -99 };
  const byBar = new Map();
  for (const s of signals) {
    if (!byBar.has(s.i)) byBar.set(s.i, []);
    byBar.get(s.i).push(s);
  }
  for (const i of [...byBar.keys()].sort((a, b) => a - b)) {
    for (const side of ['CE', 'PE']) {
      const near = [];
      for (let k = i - 2; k <= i; k++) near.push(...(byBar.get(k) || []).filter((s) => s.side === side));
      const names = [...new Set(near.map((s) => s.technique))];
      if (names.length < min || i - lastAt[side] <= 3 || !(byBar.get(i) || []).some((s) => s.side === side)) continue;
      lastAt[side] = i;
      const here = byBar.get(i).find((s) => s.side === side);
      const stop = side === 'CE' ? Math.max(...near.map((s) => s.stop)) : Math.min(...near.map((s) => s.stop));
      out.push({ ...here, technique: key, stop, note: names.map((n) => LABELS[n]?.label || n).join(' + ') });
    }
  }
  return out;
}

/** The chart read the live trader uses, asked at every 5-minute close, and the trades it would have taken. */
async function botSignals({ prep, c1, byTime, breadth, fromTime, minScore }) {
  const out = [];
  const scores = new Map(); // bar index -> the live score of each side at that close, whether or not the bot would buy
  let n = 0;
  for (let i = 15; i < prep.bars.length; i++) {
    const bar = prep.bars[i];
    const { minutes } = istParts(new Date((bar.time + 300) * 1000));
    if (bar.time < fromTime || minutes < FIRST_ENTRY_MIN || minutes >= LAST_ENTRY_MIN) continue;
    const e = byTime.get(bar.time + 300);
    if (e == null) continue;
    const next = c1[e];
    const slice = c1.slice(Math.max(0, e - 1500), e);
    slice.push({ ...next, high: next.open, low: next.open, close: next.open }); // the forming minute, with nothing of it known yet
    const now = new Date((bar.time + 300) * 1000);
    const read = readNifty({ c1: slice, daily: null, tick: { ltp: next.open }, breadthUp: breadth ? breadth[i] : null }, { now, enforceWindows: true });
    if (read.ready) scores.set(i, { CE: read.ce.score, PE: read.pe.score });
    if (read.ready && read.best && read.best.score >= minScore) {
      const day = prep.bars.slice(prep.dayStart[i], i + 1);
      const mean = day.reduce((sum, x) => sum + x.close, 0) / day.length;
      const prevClose = prep.dayStart[i] > 0 ? prep.bars[prep.dayStart[i] - 1].close : null;
      out.push({
        technique: BOT_KEY,
        side: read.best.type,
        i,
        time: bar.time + 300,
        close: bar.close,
        stop: read.best.stop.price,
        note: `score ${read.best.score}${read.best.trigger ? `, ${read.best.trigger.kind}` : ''}`,
        tag: read.best.trigger?.kind || 'no trigger',
        score: read.best.score,
        upDay: prevClose != null && bar.close > prevClose && bar.close > mean,
        atr: prep.atrAt[i],
      });
    }
    if (++n % 25 === 0) await yieldTurn();
  }
  return { signals: out, scores };
}

/** Patterns decide, the live score confirms: a pattern signal is kept only when the score of its side reached `floor` at that close. */
export function patternsWithScore(signals, scores, floor) {
  return signals
    .filter((s) => SCORE_PATTERNS.includes(s.technique))
    .map((s) => ({ ...s, score: scores.get(s.i)?.[s.side] }))
    .filter((s) => floor == null || (s.score != null && s.score >= floor));
}

/** The stop a signal is traded with: at least MIN_STOP_ATR from the entry, and `wide` when it is further than MAX_STOP_ATR (the trade is skipped). */
export function fitStop(signal, entry, base = null) {
  const d = signal.side === 'CE' ? 1 : -1;
  let stop = ruleStop(signal, entry, signal.stopRule ?? base);
  if (d * (entry - stop) < MIN_STOP_ATR * signal.atr) stop = entry - d * MIN_STOP_ATR * signal.atr;
  return { stop, wide: d * (entry - stop) > MAX_STOP_ATR * signal.atr };
}

/** One trade at a time per technique, at most MAX_PER_DAY a day, a stop at least 0.8 ATR away and no more than MAX_STOP_ATR. */
function tradesFor(signals, { c1, byTime, params }) {
  const trades = [];
  let skippedWide = 0;
  let busyUntil = 0;
  const perDay = new Map();
  for (const s of [...signals].sort((a, b) => a.time - b.time)) {
    const day = dayKey(s.time);
    if (s.time < busyUntil || (perDay.get(day) || 0) >= MAX_PER_DAY) continue;
    const entry = byTime.get(s.time) != null ? c1[byTime.get(s.time)].open : s.close;
    const { stop, wide } = fitStop(s, entry, params.stopRule);
    if (wide) {
      skippedWide += 1;
      continue;
    }
    const trade = simulateTrade({ c1, byTime, signal: { ...s, stop }, params });
    if (trade?.skipped) {
      skippedWide += 1; // the loss at its stop is more than the loss limit even for one lot
      continue;
    }
    if (!trade) continue;
    trades.push(trade);
    perDay.set(day, (perDay.get(day) || 0) + 1);
    busyUntil = trade.exitTime;
  }
  return { trades, skippedWide };
}

/**
 * @param nifty1  Nifty 1-minute candles, oldest first, a few days longer than the study so the indicators have context
 * @param stocks5 { SYMBOL: 5-minute candles } for the Nifty 50, or null when only the index is known
 * @param params  { days, iv, lockStart, lockGap, lotSize, holidays, expiryWeekday, minScore }
 */
export async function runOptionsStudy({ nifty1, stocks5 = null, params, onProgress = () => {} }) {
  const dayOf = (key) => Date.parse(`${key}T00:00:00Z`) / 86400000; // an IST date as the DAY() number
  const complete = params.to ? nifty1.filter((b) => DAY(b.time) <= dayOf(params.to)) : nifty1; // a date range ends on its last day
  const days = [...new Set(complete.map((b) => DAY(b.time)))].sort((a, b) => a - b);
  const inRange = params.from ? days.filter((d) => d >= dayOf(params.from) && d <= (params.to ? dayOf(params.to) : Infinity)) : null;
  if (inRange && inRange.length < 1) throw new Error('No saved candles between those dates. Press Download in Account > Studies > Data, or pick other dates.');
  if (inRange && inRange.length > MAX_RANGE_DAYS) throw new Error(`Pick at most ${MAX_RANGE_DAYS} trading days (that range has ${inRange.length}).`);
  const studyDays = inRange ?? days.slice(-params.days);
  const fromTime = complete.find((b) => DAY(b.time) === studyDays[0]).time;
  const byTime = new Map(complete.map((b, i) => [b.time, i]));
  let bars5 = aggregateCandles(complete, '5m');
  if (bars5.length && bars5.at(-1).time + 300 > complete.at(-1).time + 60) bars5 = bars5.slice(0, -1); // the last bucket is still forming
  onProgress('Working out the 50-stock breadth');
  const breadth = breadthSeries(bars5, stocks5);
  const flow = turnoverSeries(bars5, stocks5);
  const prep = prepare(bars5, breadth, flow);
  const midTime = complete.find((b) => DAY(b.time) === studyDays[Math.floor(studyDays.length / 2)]).time; // the older half of the study ends here

  if (params.finderOnly) return finderOnlyRun({ complete, byTime, bars5, breadth, flow, prep, studyDays, fromTime, midTime, params, onProgress });

  onProgress('Looking for each pattern on the chart');
  const found = findSignals(prep).filter((s) => s.time - 300 >= fromTime);
  const groups = Object.fromEntries(TECHNIQUES.filter((t) => available(t, { breadth: Boolean(breadth), flow: Boolean(flow) })).map((t) => [t.key, found.filter((s) => s.technique === t.key)]));
  groups.confluence = confluenceSignals(found.filter((x) => x.technique !== 'doubleBottomMid' && !EXTRA.has(x.technique))); // the tighter-stop copy is the same pattern, not a second opinion
  const agreeBase = found.filter((x) => AGREE_PATTERNS.includes(x.technique));
  groups.agree2 = confluenceSignals(agreeBase, { min: 2, key: 'agree2' });
  groups.agree3 = confluenceSignals(agreeBase, { min: 3, key: 'agree3' });
  onProgress('Replaying the current bot logic');
  const bot = await botSignals({ prep, c1: complete, byTime, breadth, fromTime, minScore: params.minScore ?? 80 });
  groups[BOT_KEY] = bot.signals;
  groups.botFiltered = bot.signals.filter((x) => x.side === 'PE' || x.upDay);
  groups.patternsAll = patternsWithScore(found, bot.scores, null);
  groups.breakoutMid = found.filter((s) => s.technique === 'breakout').map((s) => ({ ...s, technique: 'breakoutMid', stop: s.close + (s.stop - s.close) * 0.5 }));
  groups.breakoutEngulf = found.filter((s) => s.technique === 'breakout' || s.technique === 'engulfing');
  for (const { key, rule } of STOP_RULES) groups[key] = groups.breakoutEngulf.map((s) => ({ ...s, stopRule: rule }));
  for (const floor of SCORE_FLOORS) groups[`patternScore${floor}`] = patternsWithScore(found, bot.scores, floor);

  // The user's own combinations (Account > Entries): the same ones the live trader uses.
  const chart = buildChart(bars5, { breadth, flow, prep });
  const inStudy = (s) => s.time - 300 >= fromTime;
  const mine = {};
  const combosSkipped = [];
  for (const combo of params.combos || []) {
    if (combo.on === false) continue;
    const key = `combo:${combo.id}`;
    const missing = missingData(combo, chart.have);
    if (missing.length) {
      combosSkipped.push({ id: combo.id, name: combo.name, reason: `needs ${[...new Set(missing)].map((m) => (m === 'flow' ? 'volume of the 50 stocks' : m === 'breadth' ? 'the 50-stock breadth' : m)).join(' and ')}, which this run did not have` });
      continue;
    }
    mine[key] = { key, label: `My combination: ${combo.name}`, text: describeCombo(combo), combo: true };
    groups[key] = comboSignals(chart, combo).filter(inStudy);
  }

  onProgress('Trading every signal on paper');
  const techniques = [];
  let botRun = null;
  for (const [key, signals] of Object.entries(groups)) {
    const { trades, skippedWide } = tradesFor(signals, { c1: complete, byTime, params });
    if (key === BOT_KEY) botRun = { trades };
    const summary = summarize(trades);
    const info = mine[key] || LABELS[key];
    techniques.push({
      key,
      label: info.label,
      text: info.text,
      combo: Boolean(info.combo),
      halves: halvesOf(trades, midTime),
      signals: signals.length,
      skippedWide,
      ...summary,
      recent: [...trades].sort((a, b) => b.entryTime - a.entryTime).slice(0, 12),
    });
    await yieldTurn();
  }
  techniques.sort((a, b) => b.net - a.net);
  const indicators = params.rank === false ? [] : await rankIndicators({ chart, inStudy, midTime, complete, byTime, params, onProgress });
  const trainEnd = complete.find((b) => DAY(b.time) === studyDays[Math.floor((studyDays.length * 2) / 3)])?.time ?? null;
  const autoFound = params.autoFind ? await autoFind({ chart, inStudy, trainEnd, studyDays: studyDays.length, complete, byTime, params, onProgress }) : null;
  const { pairs, combos: comboFound } = params.pairFind || params.comboFind ? await finders({ chart, inStudy, trainEnd, studyDays: studyDays.length, complete, byTime, params, indicators, onProgress }) : { pairs: null, combos: null };
  const research = params.research && groups.breakoutEngulf.length ? await runResearch({ signals: groups.breakoutEngulf, tradesFor: (sigs, { params: p }) => tradesFor(sigs, { c1: complete, byTime, params: p }), midTime, trainEnd: studyDays.length >= FIND_MIN_DAYS ? trainEnd : null, params, onProgress, yieldTurn }) : params.research ? { skipped: 'Breakout and Engulfing gave no signal in this period' } : null;
  const botTrades = botRun ? botRun.trades : [];
  return {
    generatedAt: new Date().toISOString(),
    period: { from: dayKey(fromTime), to: dayKey(complete.at(-1).time), days: studyDays.length },
    params: { index: params.index ?? 'NIFTY', days: params.days, iv: params.iv, lossLimit: params.lossLimit ?? 0, maxLots: params.maxLots ?? 1, lockStart: params.lockStart, lockGap: params.lockGap, steps: params.steps ?? null, lotSize: params.lotSize, exit: params.target > 0 ? 'target' : 'lock', target: params.target ?? 0, fixedLots: params.fixedLots ?? 0, exitMin: params.exitMin ?? 15 * 60 + 15, minScore: params.minScore ?? 80, maxStopAtr: MAX_STOP_ATR, maxPerDay: MAX_PER_DAY, stopRule: params.stopRule ?? null, trail: params.trail ?? null, breakEven: params.breakEven ?? 0 },
    haveBreadth: Boolean(breadth),
    haveFlow: Boolean(flow),
    botBreakdown: botBreakdown(botTrades),
    techniques,
    indicators,
    autoFound,
    pairs,
    comboFound,
    research,
    combosSkipped,
    breadth: breadthStudy(bars5, breadth, fromTime),
  };
}

// ---------- auto-find: combinations that hold on days they were not chosen on ----------

const FIND_BASES = ['p_breakout', 'p_engulfing', 'p_momentumBar']; // the patterns that paid in the studies; a filter is added to each
const FIND_TOP = 10; // the best filters (by the older days) are also tried two at a time
const FIND_MIN_DAYS = 15;
const FIND_MIN_TRAIN = 10;
const FIND_MIN_TEST = 5;
const FIND_SHOW = 8;

/**
 * Tries each base pattern with every other check as a filter, then with the best filters in pairs, trades each on paper and judges it on two
 * parts of the period: the older two thirds (where it is picked) and the newest third (which it never saw). Only a combination that made
 * money on both, with enough trades on both, is shown. With hundreds tried, some still win by luck, so the list is a shortlist to try on paper.
 */
async function autoFind({ chart, inStudy, trainEnd, studyDays, complete, byTime, params, onProgress }) {
  if (studyDays < FIND_MIN_DAYS || trainEnd == null) return { skipped: `needs at least ${FIND_MIN_DAYS} trading days, this run had ${studyDays}` };
  const bases = FIND_BASES.filter((k) => CONDITION_BY_KEY.has(k) && usable(CONDITION_BY_KEY.get(k), chart.have));
  const filters = CONDITIONS.filter((c) => usable(c, chart.have) && c.needs !== 'news' && !c.pattern);
  const part = (trades) => {
    const m = summarize(trades);
    return { trades: m.trades, net: m.net, winRate: m.winRate };
  };
  const cache = new Map();
  let tried = 0;
  const evaluate = async (conds) => {
    const key = [...conds].sort().join('+');
    if (cache.has(key)) return cache.get(key);
    const combo = { id: key, name: key, conds, need: conds.length, window: 3 };
    const { trades } = tradesFor(comboSignals(chart, combo).filter(inStudy), { c1: complete, byTime, params });
    const row = { conds, train: part(trades.filter((t) => t.entryTime < trainEnd)), test: part(trades.filter((t) => t.entryTime >= trainEnd)), all: summarize(trades) };
    cache.set(key, row);
    tried += 1;
    if (tried % 12 === 0) {
      onProgress(`Auto-find: ${tried} combinations tried`);
      await yieldTurn();
    }
    return row;
  };

  const baselines = [];
  for (const b of bases) baselines.push({ base: b, ...(await evaluate([b])) });
  const pairs = [];
  for (const b of bases) for (const f of filters) pairs.push(await evaluate([b, f.key]));
  // the filters that did best on the older days, whichever pattern they went with
  const bestOf = new Map();
  for (const row of pairs) {
    const f = row.conds[1];
    if (row.train.trades >= FIND_MIN_TRAIN && row.train.net > (bestOf.get(f) ?? 0)) bestOf.set(f, row.train.net);
  }
  const top = [...bestOf].sort((a, b) => b[1] - a[1]).slice(0, FIND_TOP).map(([k]) => k);
  const triples = [];
  for (const b of bases) for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) triples.push(await evaluate([b, top[i], top[j]]));

  const found = [...pairs, ...triples]
    .filter((r) => r.train.trades >= FIND_MIN_TRAIN && r.train.net > 0 && r.test.trades >= FIND_MIN_TEST && r.test.net > 0)
    .sort((a, b) => b.test.net - a.test.net || b.train.net - a.train.net)
    .slice(0, FIND_SHOW)
    .map((r) => ({
      conds: r.conds,
      labels: r.conds.map((k) => CONDITION_BY_KEY.get(k).label),
      trades: r.all.trades,
      winRate: r.all.winRate,
      net: r.all.net,
      calls: r.all.bySide.CE,
      puts: r.all.bySide.PE,
      train: r.train,
      test: r.test,
    }));
  return {
    tried,
    trainEnd: dayKey(trainEnd),
    trainDays: Math.floor((studyDays * 2) / 3),
    testDays: studyDays - Math.floor((studyDays * 2) / 3),
    minTrain: FIND_MIN_TRAIN,
    minTest: FIND_MIN_TEST,
    baselines: baselines.map((b) => ({ conds: b.conds, label: CONDITION_BY_KEY.get(b.base).label, train: b.train, test: b.test })),
    found,
  };
}

/** The finder run: only the pair finder, the combination finder and the research on what they find. None of the normal study's rows are made. */
async function finderOnlyRun({ complete, byTime, bars5, breadth, flow, prep, studyDays, fromTime, midTime, params, onProgress }) {
  const chart = buildChart(bars5, { breadth, flow, prep });
  const inStudy = (s) => s.time - 300 >= fromTime;
  const trainEnd = complete.find((b) => DAY(b.time) === studyDays[Math.floor((studyDays.length * 2) / 3)])?.time ?? null;
  const needRank = (params.pairFind && !params.pairFirst) || params.comboFind;
  const indicators = needRank ? await rankIndicators({ chart, inStudy, midTime, complete, byTime, params, onProgress }) : [];
  const { pairs, combos: comboFound } = await finders({ chart, inStudy, trainEnd, midTime, studyDays: studyDays.length, complete, byTime, params, indicators, onProgress });
  return {
    generatedAt: new Date().toISOString(),
    finderOnly: true,
    period: { from: dayKey(fromTime), to: dayKey(complete.at(-1).time), days: studyDays.length },
    params: { index: params.index ?? 'NIFTY', days: params.days, iv: params.iv, lossLimit: params.lossLimit ?? 0, maxLots: params.maxLots ?? 1, lockStart: params.lockStart, lockGap: params.lockGap, steps: params.steps ?? null, lotSize: params.lotSize, exit: params.target > 0 ? 'target' : 'lock', target: params.target ?? 0, fixedLots: params.fixedLots ?? 0, exitMin: params.exitMin ?? 15 * 60 + 15, minScore: params.minScore ?? 80, maxStopAtr: MAX_STOP_ATR, maxPerDay: MAX_PER_DAY, stopRule: params.stopRule ?? null, trail: params.trail ?? null, breakEven: params.breakEven ?? 0 },
    haveBreadth: Boolean(breadth),
    haveFlow: Boolean(flow),
    botBreakdown: null,
    techniques: [],
    indicators,
    autoFound: null,
    pairs,
    comboFound,
    research: null,
    combosSkipped: [],
    breadth: null,
  };
}

const MAX_RANGE_DAYS = 65;
const RESEARCH_TOP = 5; // the best added checks of each starting point that also get the stop and exit research

/** What the research keeps of a combination: the stop rows and the best of the other groups, how far its winners went against it, and the best mix. */
function compactResearch(r, adverse) {
  if (!r || r.skipped) return null;
  const best = (group, n) => r.rows.filter((x) => x.group === group).sort((a, b) => (b.test?.net ?? b.net) - (a.test?.net ?? a.net) || b.net - a.net).slice(0, n);
  const stops = r.rows.filter((x) => x.group === 'stoprule').sort((a, b) => b.net - a.net);
  const exits = [...best('stop', 2), ...best('ladder', 3), ...best('trail', 3)];
  const steady = (x) => !r.split || (x.train?.net > 0 && x.test?.net > 0); // paid on the older and the newer days
  return { signals: r.signals, split: r.split, base: r.base, stops, exits, mix: r.mix, adverse, bestStop: stops.find(steady) ?? null, bestExit: exits.filter(steady).sort((a, b) => b.net - a.net)[0] ?? null };
}

/** How far the winning trades of a set of entries went against them before they won, per lot in rupees (a wide stop, one lot, so nothing is cut short). */
function adverseOf(trades) {
  const wins = trades.filter((t) => t.net > 0).map((t) => -t.worst).sort((a, b) => a - b);
  if (wins.length < 5) return null;
  const at = (q) => Math.round(wins[Math.min(wins.length - 1, Math.floor(q * wins.length))]);
  return { winners: wins.length, trades: trades.length, p50: at(0.5), p80: at(0.8), p90: at(0.9), max: Math.round(wins.at(-1)), losers: trades.length - wins.length };
}

/** The pair finder and the combination finder on the index's options: lists of checks traded on paper and judged on older and newer days. */
async function finders({ chart, inStudy, trainEnd, midTime = null, studyDays, complete, byTime, params, indicators, onProgress }) {
  const part = (trades) => {
    const m = summarize(trades);
    return { trades: m.trades, net: m.net, winRate: m.winRate };
  };
  let tried = 0;
  const evaluateMany = async (lists) => {
    const rows = [];
    for (const conds of lists) {
      const combo = { id: conds.join('+'), name: conds.join('+'), conds, need: conds.length, window: 3 };
      const { trades } = tradesFor(comboSignals(chart, combo).filter(inStudy), { c1: complete, byTime, params });
      const all = summarize(trades);
      rows.push({ conds, train: part(trades.filter((t) => t.entryTime < trainEnd)), test: part(trades.filter((t) => t.entryTime >= trainEnd)), all: { trades: all.trades, net: all.net, winRate: all.winRate, calls: all.bySide.CE, puts: all.bySide.PE }, list: trades.map((t) => [t.entryTime, t.net]) });
      tried += 1;
      if (tried % 12 === 0) {
        onProgress(`Finder: ${tried} combinations tried`);
        await yieldTurn();
      }
    }
    return rows;
  };
  const common = { indicators, have: chart.have, studyDays, trainEnd, evaluateMany, goal: params.pairGoal === 'winrate' ? 'winrate' : 'profit' };
  const { first, bases, missing } = pairStart(params.pairFirst, params.combos);
  const pairs = params.pairFind ? (missing ? { skipped: 'that combination is no longer saved' } : await findPairs({ ...common, first, bases, depth: params.finderOnly ? params.pairDepth ?? 3 : 1, show: params.pairShow })) : null;
  if (pairs?.anchors && params.finderOnly && params.pairResearch !== false && midTime != null) {
    // the stop and exit research for each starting point and for its best additions
    const own = new Map(bases.map((b) => [`combo:${b.id}`, comboStopRule((params.combos || []).find((c) => c.id === b.id))]));
    let n = 0;
    const total = pairs.anchors.reduce((s, a) => s + 1 + Math.min(a.found.length, RESEARCH_TOP), 0);
    const research = async (a, conds, label) => {
      onProgress(`Research on stops and exits: ${++n}/${total} (${label})`);
      const combo = { id: a.key.replace(/^combo:/, ''), name: a.label, conds, need: conds.length, window: 3 };
      const signals = comboSignals(chart, combo).filter(inStudy);
      if (signals.length < 5) return null;
      const rule = own.get(a.key) ?? params.stopRule ?? null;
      const p = { ...params, stopRule: rule };
      const r = await runResearch({ signals, tradesFor: (sigs, { params: q }) => tradesFor(sigs, { c1: complete, byTime, params: q }), midTime, trainEnd, params: p, combo: a.key.startsWith('combo:') ? combo : null, onProgress: () => {}, yieldTurn });
      const wide = tradesFor(signals, { c1: complete, byTime, params: { ...params, lossLimit: 0, fixedLots: 1, steps: params.steps, stopRule: { mode: 'atr', k: 2.5 } } }).trades;
      return compactResearch(r, adverseOf(wide));
    };
    for (const a of pairs.anchors) {
      a.research = await research(a, a.conds, a.label);
      for (const f of a.found.slice(0, RESEARCH_TOP)) f.research = await research(a, f.conds, `${a.label} + ${f.added.join(' + ')}`);
    }
  }
  return { pairs, combos: params.comboFind ? await findCombos({ ...common, show: params.pairShow ?? undefined }) : null };
}

/** Every check of the combination builder on its own: how a trade taken each time it turns true would have done. The keepers are the ones to build combinations from. */
async function rankIndicators({ chart, inStudy, midTime, complete, byTime, params, onProgress }) {
  const rows = [];
  const usableNow = CONDITIONS.filter((c) => usable(c, chart.have));
  for (const [n, cond] of usableNow.entries()) {
    if (n % 8 === 0) onProgress(`Ranking the indicators (${n + 1}/${usableNow.length})`);
    const signals = comboSignals(chart, singleCombo(cond.key)).filter(inStudy);
    const { trades } = tradesFor(signals, { c1: complete, byTime, params });
    const m = summarize(trades);
    const halves = halvesOf(trades, midTime);
    rows.push({ key: cond.key, label: cond.label, group: cond.group, kind: cond.kind, text: cond.text, trades: m.trades, winRate: m.winRate, net: m.net, avgNet: m.avgNet, calls: m.bySide.CE, puts: m.bySide.PE, halves, verdict: verdictOf({ trades: m.trades, net: m.net, halves }) });
    await yieldTurn();
  }
  return rows.sort((a, b) => b.net - a.net);
}
