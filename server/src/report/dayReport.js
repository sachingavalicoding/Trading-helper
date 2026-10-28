import { summarizeLog } from '../auto/logSummary.js';
import { summarizeIdeas, resultR } from '../scanner/stats.js';
import { TRADE_DEFAULTS, ladderText } from '../models/TradeDefaults.js';

// One day of everything the scanner, the auto trader and the options trader did, as plain text, so it can be copied
// from the app and pasted into a chat for review. No secrets and no personal data: only prices, rules and results.

const round = (n, d = 2) => (n == null || Number.isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const inr = (n) => (n == null ? '-' : `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`);
const clock = (d) => (d ? new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '--:--');
const signed = (n, suffix = '') => (n == null ? '-' : `${n > 0 ? '+' : ''}${round(n)}${suffix}`);
const cut = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));
const MAX_ROWS = 60;

const lockText = (r, stopLabel = 'stop') => `${r.stopLoss > 0 ? `${stopLabel} ₹${r.stopLoss} a trade` : 'no automatic stop'}; ${r.steps?.length > 1 ? `profit lock ladder: ${ladderText(r.steps)} (above a row the stop follows that row's gap behind the best profit)` : r.lockStart > 0 ? `once the profit reaches ₹${r.lockStart} the stop follows ₹${r.lockGap} behind the best profit` : 'no profit lock'}`;

function rules({ auto, options, rules: lock = TRADE_DEFAULTS }) {
  const lines = [];
  if (auto) lines.push(`- Auto shares: ${auto.enabled ? 'ON' : 'off'}, min score ${auto.minScore}, max ${auto.maxOpen} open, stop for the day after -${auto.dailyLossPct}%, max ₹${auto.maxTradeAmount} a trade, no sale target; ${lockText(lock.shares)}.`);
  if (options) lines.push(`- Auto options: ${options.enabled ? 'ON' : 'off'}, min score ${options.minScore}, budget ₹${options.budget}, max ${options.maxLots} lots, ${options.maxTrades} trades a day, chart stop (closed 1-minute candle), no target and no trailing; ${lockText(lock.options, 'loss limit')}.`);
  return lines;
}

function ideaLines(ideas) {
  const done = ideas.filter((i) => i.status !== 'OPEN');
  const count = (s) => ideas.filter((i) => i.status === s).length;
  const head = `## Scanner ideas (${ideas.length}: ${count('TARGET_HIT')} reached target 1, ${count('STOPPED')} stopped, ${count('EXPIRED')} expired, ${count('OPEN')} still open)`;
  if (!ideas.length) return [head, 'None raised.'];
  const lines = ideas.slice(0, MAX_ROWS).map((i) => {
    const r = resultR(i);
    return `- ${clock(i.createdAt)} ${i.symbol} ${i.side} ${i.setup} score ${i.score}: entry ${i.entry}, SL ${i.stopLoss}, T1 ${i.target1} -> ${i.status}${i.exitPrice != null ? ` at ${i.exitPrice}` : ''}${r != null ? ` (${signed(r, 'R')})` : ''}, best ${signed(i.bestR, 'R')}, worst ${signed(i.worstR, 'R')}`;
  });
  if (ideas.length > MAX_ROWS) lines.push(`(${ideas.length - MAX_ROWS} more not shown)`);
  const s = summarizeIdeas(ideas.map((i) => ({ ...i, openedAt: i.createdAt })));
  if (done.length) lines.push(`By setup today: ${s.bySetup.map((g) => `${g.key} ${g.count} (${g.wins} won, avg ${signed(g.avgR, 'R')})`).join('; ')}`);
  return [head, ...lines];
}

function tradeLines(title, entries, { options = false } = {}) {
  const placed = entries.filter((e) => e.decision === 'PLACED');
  const sum = summarizeLog(entries);
  const head = `## ${title} (${sum.placed} placed, ${sum.closed} closed: ${sum.wins} won, ${sum.losses} lost, net ${inr(sum.netPnl)} after ₹${Math.round(sum.charges)} charges)`;
  const lines = [head];
  if (!placed.length) lines.push('No trades placed.');
  for (const e of placed.slice(0, MAX_ROWS)) {
    const o = e.outcome;
    const what = options ? `${e.detail?.label || e.symbol}${e.detail?.manual ? ' (by hand)' : ''}, ${e.detail?.lots ?? '?'} lot` : `${e.symbol} ${e.side} qty ${e.qty}`;
    lines.push(
      `- ${clock(e.decidedAt)} ${what} ${e.setup || ''} score ${e.score ?? '-'}: bought at ${e.fillPrice ?? e.entry}, stop ${e.stopLoss}${o ? ` -> ${o.exitReason} at ${o.exitPrice}, net ${inr(o.netPnl)} (${signed(o.resultR, 'R')}), best ${signed(o.bestR, 'R')}, worst ${signed(o.worstR, 'R')}, held ${o.minutesHeld} min` : ' -> still open'}`,
    );
  }
  if (sum.byExit.length) lines.push(`Exits: ${sum.byExit.map((g) => `${g.key} ${g.trades} (net ${inr(g.netPnl)})`).join('; ')}`);
  if (sum.gaveBack) lines.push(`${sum.gaveBack} trade(s) were up half the risk or more and still ended as a loss.`);
  if (sum.skipReasons.length) lines.push(`Skipped ${sum.skipped}: ${sum.skipReasons.slice(0, 8).map((r) => `${r.count}x ${cut(r.example, 90)}`).join('; ')}`);
  return lines;
}

function newsLines(review) {
  if (!review) return ['## Morning news calls vs the day', 'Not available (price history not loaded).'];
  const calls = review.stocks.filter((r) => r.news?.result);
  const s = review.summary?.news;
  const head = `## Morning news calls vs the day (${calls.length} stocks${s?.hitRate != null ? `, hit rate ${s.hitRate}%` : ''})`;
  const lines = calls.slice(0, MAX_ROWS).map((r) => `- ${r.symbol} ${r.news.label} (${cut(r.news.title, 80)}): open to close ${signed(r.move?.openToClosePct, '%')} -> ${r.news.result.verdict}`);
  if (review.nifty) lines.push(`Nifty 50 open to close ${signed(review.nifty.move.openToClosePct, '%')} (high ${signed(review.nifty.move.openToHighPct, '%')}, low ${signed(review.nifty.move.openToLowPct, '%')} from the open).`);
  return [head, ...(calls.length ? lines : ['No news calls.'])];
}

/** The whole report as text. Every part tolerates missing data. */
export function buildDayReport({ day, generatedAt, market, settings = {}, ideas = [], eqLog = [], optLog = [], review = null, track = null }) {
  const out = [`# Nifty paper trader: day report for ${day}`, `Generated ${clock(generatedAt)} IST. Feed: ${market?.provider || 'unknown'}${market?.simulated ? ' (SIMULATED prices)' : ''}. Paper money only.`, '', '## Rules in force', ...rules(settings), ''];
  out.push(...ideaLines(ideas), '');
  out.push(...tradeLines('Auto share trades', eqLog), '');
  out.push(...tradeLines('Auto and manual option trades', optLog, { options: true }), '');
  out.push(...newsLines(review), '');
  if (track?.overall?.count) {
    out.push(`## Scanner track record (all finished ideas)`, `${track.overall.count} ideas, ${track.overall.winRate}% reached target 1, avg ${signed(track.overall.avgR, 'R')}. By setup: ${track.bySetup.slice(0, 8).map((g) => `${g.key} ${g.count} (${g.winRate}%, ${signed(g.avgR, 'R')})`).join('; ')}`, '');
  }
  return out.join('\n').trimEnd() + '\n';
}
