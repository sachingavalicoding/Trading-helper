import { NIFTY50 } from '../market/instruments.js';
import { istParts } from '../market/marketHours.js';
import { addDays } from '../market/days.js';
import { aggregateCandles } from '../market/providers/BaseProvider.js';
import { AutoLog, NewsItem, OptionSettings, Position, ScanIdea } from '../models/index.js';
import { summarise, MARKET } from '../news/service.js';
import { summarizeIdeas, resultR } from '../scanner/stats.js';
import { summarizeLog } from '../auto/logSummary.js';
import { DEFAULT_LOT_SIZE, UNDERLYING, optionLabel } from '../options/symbols.js';
import { loadRules } from '../models/TradeDefaults.js';
import { reviewPatterns } from './patterns.js';
import { normalizeCombos } from '../combos/combos.js';
import { stopRuleOf } from '../study/patterns.js';
import { candleDay, candleOn, dirOf, judge, moveOf, morningWindow, prevCloseBefore, sessionAfter, tally } from './day.js';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Which family of technique a scanner setup belongs to, so "breakouts" can be compared with "trend follow". */
export const SETUP_FAMILY = {
  'Opening range breakout': 'Breakout',
  'Gap and go': 'Breakout',
  'News gap': 'News gap',
  'VWAP pullback': 'Trend follow',
  'Level retest': 'Level retest',
};

const CHECK_SUPPORTS = 0.5; // a check "supports" a trade when it earned at least this share of its points

/** Headline fields a screen needs, tagged for the morning call. */
const headline = (d) => ({ id: String(d._id), title: d.title, url: d.url, source: d.source, publishedAt: d.publishedAt, label: d.label, sentiment: d.sentiment, category: d.category, reasons: d.reasons });

/**
 * Looks back at calls (news tags and scanner ideas) against what each stock really did that day.
 * Nothing here predicts anything: every call is rebuilt from what was stored when it was made
 * (the headline tags never change, and a scanner idea is frozen when raised).
 */
export class ReviewService {
  constructor({ market, config = null, now = () => new Date() }) {
    this.market = market;
    this.config = config;
    this.now = now;
    this.cache = new Map();
  }

  get today() {
    return istParts(this.now()).dateKey;
  }

  /** Daily candles for one symbol, with today's running candle patched from the live tick when the feed has not sent it yet. */
  async #daily(symbol) {
    try {
      return (await this.market.getDaily(symbol)) || [];
    } catch {
      return [];
    }
  }

  /** Open, high, low, close of `day` for a symbol, falling back to the live tick for today. */
  async moveOn(symbol, day, daily = null) {
    const list = daily ?? (await this.#daily(symbol));
    let candle = candleOn(list, day);
    if (day === this.today) {
      const t = this.market.getTick(symbol);
      if (t?.open && (!candle || candle.close !== t.ltp)) candle = { open: t.open, high: Math.max(t.high ?? t.ltp, t.ltp), low: Math.min(t.low ?? t.ltp, t.ltp), close: t.ltp };
    }
    return moveOf(candle, prevCloseBefore(list, day) ?? this.market.getTick(symbol)?.prevClose ?? null);
  }

  /** Everything for one trading day: stock calls from news and scanner ideas, the Nifty, and the user's option decisions. */
  async day(userId, day) {
    const { from, to } = morningWindow(day);
    const [news, ideas, optLog] = await Promise.all([
      NewsItem.find({ symbol: { $ne: MARKET }, publishedAt: { $gte: from, $lt: to }, label: { $ne: 'NEUTRAL' } }).sort({ publishedAt: -1 }).lean(),
      ScanIdea.find({ day }).sort({ createdAt: 1 }).lean(),
      AutoLog.find({ user: userId, day, segment: 'OPT' }).sort({ decidedAt: 1 }).lean(),
    ]);
    const newsBy = new Map();
    for (const d of news) newsBy.set(d.symbol, [...(newsBy.get(d.symbol) || []), d]);
    const ideasBy = new Map();
    for (const i of ideas) ideasBy.set(i.symbol, [...(ideasBy.get(i.symbol) || []), i]);

    const symbols = NIFTY50.filter((s) => newsBy.has(s.symbol) || ideasBy.has(s.symbol));
    const rows = await Promise.all(
      symbols.map(async (s) => {
        const move = await this.moveOn(s.symbol, day);
        const items = newsBy.get(s.symbol) || [];
        const sum = summarise(items.map((d) => ({ ...headline(d), reaction: null })));
        const lead = sum && items.find((d) => d.title === sum.title);
        const newsCall = sum ? { label: sum.label, net: sum.net, count: sum.count, ...headline(lead), result: judge(dirOf(sum.label), move) } : null;
        const ideaCalls = (ideasBy.get(s.symbol) || []).map((i) => ({
          id: String(i._id),
          setup: i.setup,
          family: SETUP_FAMILY[i.setup] || i.setup,
          side: i.side,
          score: i.score,
          entry: i.entry,
          stopLoss: i.stopLoss,
          target1: i.target1,
          status: i.status,
          exitPrice: i.exitPrice,
          resultR: round(resultR(i) ?? 0),
          bestR: i.bestR ?? null,
          raisedAt: i.createdAt,
          result: judge(dirOf(i.side), move),
        }));
        return { symbol: s.symbol, name: s.name, sector: s.sector, move, news: newsCall, ideas: ideaCalls };
      }),
    );
    // headlines that cancel out make no call, so a stock with no call and no idea has nothing to review
    for (let i = rows.length - 1; i >= 0; i--) if (!rows[i].news && !rows[i].ideas.length) rows.splice(i, 1);
    rows.sort((a, b) => Math.abs(b.move?.openToClosePct ?? 0) - Math.abs(a.move?.openToClosePct ?? 0));

    const newsCalls = rows.filter((r) => r.news?.result).map((r) => ({ symbol: r.symbol, ...r.news }));
    const ideaCalls = rows.flatMap((r) => r.ideas.filter((i) => i.result).map((i) => ({ symbol: r.symbol, ...i })));
    const doneIdeas = ideaCalls.filter((i) => i.status !== 'OPEN');
    const best = [...newsCalls].sort((a, b) => b.result.edgePct - a.result.edgePct);

    const nifty = await this.moveOn(UNDERLYING, day);
    const options = optLog.map(({ card, ...e }) => {
      const type = e.detail?.type;
      return {
        id: String(e._id),
        decision: e.decision,
        type,
        label: e.detail?.label || (e.symbol ? optionLabel(e.symbol) : null),
        score: e.score,
        reason: e.reason,
        manual: Boolean(e.detail?.manual),
        spotAtEntry: e.detail?.spot ?? null,
        outcome: e.outcome || null,
        decidedAt: e.decidedAt,
        niftyAgreed: type && nifty ? judge(type === 'CE' ? 1 : -1, nifty)?.verdict ?? null : null,
      };
    });

    return {
      day,
      summary: {
        news: { calls: newsCalls.length, ...(tally(newsCalls.map((c) => ({ result: c.result })), () => 'all')[0] || { hits: 0, misses: 0, flat: 0, hitRate: null, avgEdgePct: null, avgBestPct: null, avgDipPct: null }) },
        ideas: {
          calls: ideaCalls.length,
          finished: doneIdeas.length,
          targets: doneIdeas.filter((i) => i.status === 'TARGET_HIT').length,
          stopped: doneIdeas.filter((i) => i.status === 'STOPPED').length,
          avgR: doneIdeas.length ? round(doneIdeas.reduce((s, i) => s + i.resultR, 0) / doneIdeas.length) : null,
        },
        bestCall: best[0] ? { symbol: best[0].symbol, edgePct: best[0].result.edgePct, title: best[0].title } : null,
        worstCall: best.length > 1 ? { symbol: best.at(-1).symbol, edgePct: best.at(-1).result.edgePct, title: best.at(-1).title } : null,
      },
      stocks: rows,
      nifty: nifty && {
        move: nifty,
        // What a call (CE) or a put (PE) bought at the open would have seen, on the index alone.
        ifCallAtOpen: { closePct: nifty.openToClosePct, bestPct: Math.max(0, nifty.openToHighPct), dipPct: Math.min(0, nifty.openToLowPct) },
        ifPutAtOpen: { closePct: round(-nifty.openToClosePct), bestPct: Math.max(0, round(-nifty.openToLowPct)), dipPct: Math.min(0, round(-nifty.openToHighPct)) },
      },
      options: { summary: summarizeLog(optLog.filter((e) => e.decision === 'PLACED' || e.decision === 'SKIPPED')), entries: options },
    };
  }

  /** The 50 stocks' 5-minute candles around `day` from the saved history, or null when none are saved (the volume patterns then wait). */
  async #savedStocks5(day) {
    const history = this.market.history;
    if (!history) return null;
    const out = {};
    for (const { symbol } of NIFTY50) {
      const stored = await history.read(symbol, addDays(day, -9), addDays(day, 1)).catch(() => []);
      if (stored.length) out[symbol] = aggregateCandles(stored.map((c) => ({ ...c })), '5m');
    }
    return Object.keys(out).length ? out : null;
  }

  /** The Nifty chart of one day with every pattern that formed on it, and what a one-lot option buy at each would have done. */
  async patterns(userId, day) {
    const [c1, rules, settings] = await Promise.all([this.market.getMinutes(UNDERLYING, day), loadRules(userId, 'OPT'), OptionSettings.findOne({ user: userId }).lean()]);
    const params = {
      iv: 0.14,
      lockStart: rules.lockStart || 1000,
      lockGap: rules.lockGap || 250,
      steps: rules.steps,
      lotSize: this.config?.niftyLotSize ?? DEFAULT_LOT_SIZE,
      holidays: this.config?.nseHolidays ?? [],
      expiryWeekday: this.market.expiryWeekday,
      lossLimit: rules.stopLoss ?? 0,
      maxLots: settings?.maxLots ?? 2,
      exitMin: rules.exitMin,
    };
    if (!c1.length) return { day, candles: [], signals: [], patterns: [] };
    return reviewPatterns({ c1, day, params, stocks5: await this.#savedStocks5(day), combos: normalizeCombos(settings?.combos), stopRule: stopRuleOf(settings) });
  }

  /** One stock on one day: its 5-minute chart, the news with what the price did after each headline, the ideas and the user's trades. */
  async stock(userId, symbol, day) {
    const inst = NIFTY50.find((s) => s.symbol === symbol) || (symbol === UNDERLYING ? { symbol, name: 'Nifty 50', sector: 'Index' } : null);
    if (!inst) return null;
    const [daily, c1] = await Promise.all([this.#daily(symbol), this.market.getMinutes(symbol, day)]);
    const candles = aggregateCandles(c1, '5m').filter((c) => istParts(new Date(c.time * 1000)).dateKey === day);
    const move = await this.moveOn(symbol, day, daily);
    const dayStart = new Date(`${day}T00:00:00+05:30`);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600_000);
    const since = new Date(dayStart.getTime() - 24 * 3600_000);
    const [news, ideas, positions] = await Promise.all([
      symbol === UNDERLYING ? NewsItem.find({ symbol: MARKET, publishedAt: { $gte: since, $lt: dayEnd } }).sort({ publishedAt: 1 }).lean() : NewsItem.find({ symbol, publishedAt: { $gte: since, $lt: dayEnd } }).sort({ publishedAt: 1 }).lean(),
      ScanIdea.find({ day, symbol }).sort({ createdAt: 1 }).lean(),
      Position.find({ user: userId, tradingDay: day, symbol }).sort({ openedAt: 1 }).lean(),
    ]);
    const priceAt = (t) => {
      const sec = new Date(t).getTime() / 1000;
      const c = candles.find((x) => x.time <= sec && sec < x.time + 300);
      return c ? c.open : null;
    };
    const lastClose = move?.close ?? candles.at(-1)?.close ?? null;
    const headlines = news.map((d) => {
      const live = priceAt(d.publishedAt); // published while the market was open
      const base = live ?? move?.open ?? null; // before the open: the move is measured from the open
      const dir = dirOf(d.label);
      return {
        ...headline(d),
        timing: live != null ? 'DURING' : new Date(d.publishedAt) < dayStart || istParts(new Date(d.publishedAt)).minutes < 9 * 60 + 15 ? 'BEFORE_OPEN' : 'AFTER_CLOSE',
        priceThen: base,
        moveToClosePct: base && lastClose ? round(((lastClose - base) / base) * 100) : null,
        agreed: dir && base && lastClose ? Math.sign(lastClose - base) === dir : null,
      };
    });
    return {
      symbol,
      name: inst.name,
      sector: inst.sector,
      day,
      move,
      candles,
      news: headlines,
      ideas: ideas.map((i) => ({ id: String(i._id), setup: i.setup, side: i.side, score: i.score, entry: i.entry, stopLoss: i.stopLoss, target1: i.target1, status: i.status, exitPrice: i.exitPrice, bestR: i.bestR ?? null, worstR: i.worstR ?? null, resultR: round(resultR(i) ?? 0), raisedAt: i.createdAt, closedAt: i.closedAt || null })),
      trades: positions.map((p) => ({ id: String(p._id), direction: p.direction, qty: p.buyQty || p.sellQty, avgPrice: p.avgPrice, realizedPnl: p.realizedPnl, charges: p.charges, status: p.status, openedAt: p.openedAt, closedAt: p.closedAt || null })),
    };
  }

  /**
   * Which techniques earn money, from the scanner's finished ideas (all users, in risk units R),
   * this user's own auto trades (in rupees), which chart checks were present in winning ideas, and
   * how stocks reacted to each kind of headline.
   */
  async techniques(userId, days = 30) {
    const key = `${userId}|${days}|${this.today}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value;
    const since = istParts(new Date(this.now().getTime() - days * 86400_000)).dateKey;
    const [ideas, trades, optTrades] = await Promise.all([
      ScanIdea.find({ day: { $gte: since }, status: { $ne: 'OPEN' } }, 'setup side status entry stopLoss exitPrice score createdAt closedAt bestR card.checks').lean(),
      AutoLog.find({ user: userId, day: { $gte: since }, segment: 'EQ', decision: 'PLACED', status: 'CLOSED' }).lean(),
      AutoLog.find({ user: userId, day: { $gte: since }, segment: 'OPT', decision: 'PLACED', status: 'CLOSED' }).lean(),
    ]);
    const stats = summarizeIdeas(ideas.map((i) => ({ ...i, openedAt: i.createdAt })));

    // Families: the setups rolled up, so "breakouts" are one line.
    const fam = new Map();
    for (const i of ideas) {
      const f = SETUP_FAMILY[i.setup] || i.setup;
      fam.set(f, [...(fam.get(f) || []), i]);
    }
    const byFamily = [...fam].map(([key, list]) => {
      const rs = list.map(resultR).filter((r) => r != null);
      const wins = list.filter((i) => i.status === 'TARGET_HIT').length;
      return { key, count: list.length, winRate: round((wins / list.length) * 100, 0), avgR: rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : null, totalR: round(rs.reduce((a, b) => a + b, 0)) };
    }).sort((a, b) => (b.totalR ?? 0) - (a.totalR ?? 0));

    // For each chart check: how ideas did when it supported them and when it did not (RSI, VWAP, volume, MACD ...).
    const checks = new Map();
    for (const i of ideas) {
      const r = resultR(i);
      if (r == null) continue;
      for (const c of i.card?.checks || []) {
        if (!c.max) continue;
        const slot = checks.get(c.id) || { id: c.id, label: c.label, with: [], without: [] };
        (c.points >= c.max * CHECK_SUPPORTS ? slot.with : slot.without).push(r);
        checks.set(c.id, slot);
      }
    }
    const avg = (rs) => (rs.length ? round(rs.reduce((a, b) => a + b, 0) / rs.length) : null);
    const byCheck = [...checks.values()]
      .map((c) => ({ id: c.id, label: c.label, withCount: c.with.length, withAvgR: avg(c.with), withoutCount: c.without.length, withoutAvgR: avg(c.without), liftR: c.with.length && c.without.length ? round(avg(c.with) - avg(c.without)) : null }))
      .filter((c) => c.withCount >= 5)
      .sort((a, b) => (b.liftR ?? -99) - (a.liftR ?? -99));

    const log = summarizeLog(trades);
    const optLogSummary = summarizeLog(optTrades);

    // How stocks reacted to each kind of headline that was out before an open.
    const news = await NewsItem.find({ symbol: { $ne: MARKET }, publishedAt: { $gte: new Date(this.now().getTime() - days * 86400_000) }, label: { $ne: 'NEUTRAL' } }, 'symbol publishedAt label category').lean();
    const bySymbol = new Map();
    for (const n of news) bySymbol.set(n.symbol, [...(bySymbol.get(n.symbol) || []), n]);
    const calls = [];
    await Promise.all(
      [...bySymbol].map(async ([symbol, list]) => {
        const daily = await this.#daily(symbol);
        for (const n of list) {
          const c = sessionAfter(n.publishedAt, daily);
          if (!c) continue;
          const day = candleDay(c);
          if (day > this.today || (day === this.today && istParts(this.now()).minutes < 15 * 60 + 30)) continue; // the session is not finished
          const result = judge(dirOf(n.label), moveOf(c, prevCloseBefore(daily, day)));
          if (result) calls.push({ category: n.category, label: n.label, result });
        }
      }),
    );

    const value = {
      days,
      since,
      scanner: { overall: stats.overall, bySetup: stats.bySetup.map((r) => ({ ...r, family: SETUP_FAMILY[r.key] || r.key })), byFamily, bySide: stats.bySide, byHour: stats.byHour, byScore: stats.byScore, byCheck },
      trades: { equity: { closed: log.closed, wins: log.wins, netPnl: log.netPnl, bySetup: log.bySetup, byExit: log.byExit }, options: { closed: optLogSummary.closed, wins: optLogSummary.wins, netPnl: optLogSummary.netPnl, byExit: optLogSummary.byExit, byType: groupBy(optTrades, (e) => e.detail?.type || '?') } },
      news: { calls: calls.length, byCategory: tally(calls, (c) => c.category), byLabel: tally(calls, (c) => c.label) },
    };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}

function groupBy(list, keyOf) {
  const map = new Map();
  for (const e of list) map.set(keyOf(e), [...(map.get(keyOf(e)) || []), e]);
  return [...map].map(([key, rows]) => ({
    key,
    trades: rows.length,
    wins: rows.filter((e) => e.outcome.netPnl > 0).length,
    netPnl: round(rows.reduce((s, e) => s + (e.outcome.netPnl || 0), 0)),
  }));
}
