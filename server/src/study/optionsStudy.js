import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { istParts } from '../market/marketHours.js';
import { readNifty, FIRST_ENTRY_MIN, LAST_ENTRY_MIN } from '../options/signal.js';
import { round2 } from '../utils/money.js';
import { TECHNIQUES, prepare, findSignals, MIN_STOP_ATR, MAX_STOP_ATR } from './patterns.js';
import { simulateTrade, summarize } from './simulate.js';

// The options study: what each way of reading the Nifty chart would have earned on the last few weeks, as paper trades of one lot.
// It reads history and changes nothing: the live trading rules are not touched by it.

const DAY = (t) => Math.floor((t + 19800) / 86400);
const dayKey = (t) => istParts(new Date(t * 1000)).dateKey;
const MAX_PER_DAY = 3; // the live options trader also stops after 3 entries a day
const BOT_KEY = 'bot';
const LABELS = {
  ...Object.fromEntries(TECHNIQUES.map((t) => [t.key, t])),
  confluence: { key: 'confluence', label: 'Two or more agree', text: 'Two different techniques give the same direction within 15 minutes. Stop at the nearest of their stops.' },
  botFiltered: { key: 'botFiltered', label: 'Current bot, calls only in an up-day', text: 'The current bot, but a call is taken only when Nifty is above yesterday close and above the day average. Puts are unchanged.' },
  [BOT_KEY]: { key: BOT_KEY, label: 'Current bot (all checks)', text: 'What the live options trader does today: every chart check must agree and the score must reach the minimum. Shown to compare the others against.' },
};

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

function confluenceSignals(signals) {
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
      if (names.length < 2 || i - lastAt[side] <= 3 || !(byBar.get(i) || []).some((s) => s.side === side)) continue;
      lastAt[side] = i;
      const here = byBar.get(i).find((s) => s.side === side);
      const stop = side === 'CE' ? Math.max(...near.map((s) => s.stop)) : Math.min(...near.map((s) => s.stop));
      out.push({ ...here, technique: 'confluence', stop, note: names.map((n) => LABELS[n]?.label || n).join(' + ') });
    }
  }
  return out;
}

/** The chart read the live trader uses, asked at every 5-minute close, and the trades it would have taken. */
async function botSignals({ prep, c1, byTime, breadth, fromTime, minScore }) {
  const out = [];
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
  return out;
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
    const d = s.side === 'CE' ? 1 : -1;
    const entry = byTime.get(s.time) != null ? c1[byTime.get(s.time)].open : s.close;
    let stop = s.stop;
    if (d * (entry - stop) < MIN_STOP_ATR * s.atr) stop = entry - d * MIN_STOP_ATR * s.atr;
    if (d * (entry - stop) > MAX_STOP_ATR * s.atr) {
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
  const complete = nifty1;
  const days = [...new Set(complete.map((b) => DAY(b.time)))].sort((a, b) => a - b);
  const studyDays = days.slice(-params.days);
  const fromTime = complete.find((b) => DAY(b.time) === studyDays[0]).time;
  const byTime = new Map(complete.map((b, i) => [b.time, i]));
  let bars5 = aggregateCandles(complete, '5m');
  if (bars5.length && bars5.at(-1).time + 300 > complete.at(-1).time + 60) bars5 = bars5.slice(0, -1); // the last bucket is still forming
  onProgress('Working out the 50-stock breadth');
  const breadth = breadthSeries(bars5, stocks5);
  const prep = prepare(bars5, breadth);

  onProgress('Looking for each pattern on the chart');
  const found = findSignals(prep).filter((s) => s.time - 300 >= fromTime);
  const groups = Object.fromEntries(TECHNIQUES.filter((t) => t.key !== 'breadth' || breadth).map((t) => [t.key, found.filter((s) => s.technique === t.key)]));
  groups.confluence = confluenceSignals(found.filter((x) => x.technique !== 'doubleBottomMid')); // the tighter-stop copy is the same pattern, not a second opinion
  onProgress('Replaying the current bot logic');
  groups[BOT_KEY] = await botSignals({ prep, c1: complete, byTime, breadth, fromTime, minScore: params.minScore ?? 80 });
  groups.botFiltered = groups[BOT_KEY].filter((x) => x.side === 'PE' || x.upDay);

  onProgress('Trading every signal on paper');
  const techniques = [];
  let botRun = null;
  for (const [key, signals] of Object.entries(groups)) {
    const { trades, skippedWide } = tradesFor(signals, { c1: complete, byTime, params });
    if (key === BOT_KEY) botRun = { trades };
    const summary = summarize(trades);
    techniques.push({
      key,
      label: LABELS[key].label,
      text: LABELS[key].text,
      signals: signals.length,
      skippedWide,
      ...summary,
      recent: [...trades].sort((a, b) => b.entryTime - a.entryTime).slice(0, 12),
    });
    await yieldTurn();
  }
  techniques.sort((a, b) => b.net - a.net);
  const botTrades = botRun ? botRun.trades : [];
  return {
    generatedAt: new Date().toISOString(),
    period: { from: dayKey(fromTime), to: dayKey(complete.at(-1).time), days: studyDays.length },
    params: { days: params.days, iv: params.iv, lossLimit: params.lossLimit ?? 0, maxLots: params.maxLots ?? 1, lockStart: params.lockStart, lockGap: params.lockGap, lotSize: params.lotSize, minScore: params.minScore ?? 80, maxStopAtr: MAX_STOP_ATR, maxPerDay: MAX_PER_DAY },
    haveBreadth: Boolean(breadth),
    botBreakdown: botBreakdown(botTrades),
    techniques,
    breadth: breadthStudy(bars5, breadth, fromTime),
  };
}
