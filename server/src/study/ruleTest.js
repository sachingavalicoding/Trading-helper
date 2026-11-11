import { evaluate, netResult } from '../scanner/backtest.js';
import { roundTripCharges } from '../services/charges.js';
import { DEFAULT_SHARE_RULES, ruleBlock, shareRulesOf } from '../scanner/entryRules.js';
import { TRY_TARGETS } from '../scanner/replay.js';
import { istParts } from '../market/marketHours.js';

// "Test the new entry rules" in the Shares study (added 11 Nov 2026). The scanner is replayed once on the saved days as the live scanner
// would raise its ideas (scanner/replay.js liveIdea), then every rule is tried on those same ideas: your settings now, and your settings
// with one change. A rule only counts as better when it made more money AND did not do worse in either half of the days, so one lucky
// day cannot make it look good. It reads history and changes nothing.

const MIN_TRADES = 10; // fewer trades than this say nothing
const MAX_CHARGES_OF_RISK = 0.25; // the live auto trader's own checks (auto/autoTrader.js)
const MIN_PROFIT_TO_CHARGES = 3;
const DAY = (iso) => iso.slice(0, 10);

/** The ideas your current switches let through, as trades, after one set of rules (rules.target > 0: sold at that profit, if the replay tried it). */
export function tradesFor(ideas, { minScore, setupOn, rules }) {
  const out = [];
  const exit = rules.target > 0 ? rules.target : 'ladder';
  const lockKey = !(rules.target > 0) && rules.lockFromR > 0 ? String(rules.lockFromR) : null; // the profit lock in risks, when on
  for (const i of ideas) {
    if (!setupOn(i.setup) || i.score < minScore) continue;
    const at = istParts(new Date(i.openedAt)).minutes;
    if (at < (rules.entryFrom ?? 0) || at >= (rules.entryTo ?? 24 * 60)) continue; // your share entry hours (Account)
    const stopPct = i.facts?.stopPct ?? (Math.abs(i.entry - i.stopLoss) / i.entry) * 100;
    if (stopPct < rules.minStopPct) continue;
    if (ruleBlock(rules, i.facts, i.side)) continue;
    let t = { side: i.side, setup: i.setup, entry: i.entry, stopLoss: i.stopLoss, target1: i.target1, openedAt: i.openedAt, status: i.status, exit: i.exit, exitPrice: i.exitPrice, exitTime: i.exitTime, sizedQty: i.sizedQty };
    if (exit !== 'ladder' && i.targets?.[exit]) t = { ...t, ...i.targets[exit] };
    else if (lockKey && i.rlocks?.[lockKey]) t = { ...t, ...i.rlocks[lockKey] };
    if (rules.confirmBar) {
      if (!i.confirmed || i.confirmed.dropped) continue;
      const c = i.confirmed;
      // waiting for the close changes the entry, and the exit is followed from there
      const x = exit !== 'ladder' && c.targets?.[exit] ? c.targets[exit] : lockKey && c.rlocks?.[lockKey] ? c.rlocks[lockKey] : c;
      t = { ...t, entry: c.entry, openedAt: c.openedAt, status: x.status, exit: x.exit, exitPrice: x.exitPrice, exitTime: x.exitTime, sizedQty: x.sizedQty };
    }
    if (!t.sizedQty) continue;
    const charges = roundTripCharges({ qty: t.sizedQty, price: t.entry });
    const atRisk = t.sizedQty * Math.abs(t.entry - t.stopLoss);
    if (atRisk > 0 && charges > MAX_CHARGES_OF_RISK * atRisk) continue;
    if (t.sizedQty * Math.abs(t.target1 - t.entry) < MIN_PROFIT_TO_CHARGES * charges) continue;
    out.push(t);
  }
  return rules.stopAfterLosses > 0 ? stopAfterLosses(out, rules.stopAfterLosses) : out;
}

/** Drop every trade of a day that would start after `n` losing trades of that day had already closed. */
function stopAfterLosses(trades, n, opts = {}) {
  const sorted = [...trades].sort((a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt));
  const kept = [];
  for (const t of sorted) {
    const at = Date.parse(t.openedAt) / 1000;
    const lost = kept.filter((k) => DAY(k.openedAt) === DAY(t.openedAt) && k.exitTime != null && k.exitTime <= at && (netResult(k, opts)?.net ?? 0) < 0).length;
    if (lost < n) kept.push(t);
  }
  return kept;
}

function summary(trades, opts, days) {
  const all = evaluate(trades, opts);
  const mid = days[Math.floor(days.length / 2)];
  const half = (pick) => evaluate(trades.filter((t) => pick(DAY(t.openedAt))), opts).totalNet;
  const perDay = Object.fromEntries(days.map((d) => [d, evaluate(trades.filter((t) => DAY(t.openedAt) === d), opts).totalNet]));
  return { trades: all.trades, winRate: all.winRate, totalNet: all.totalNet, avgNet: all.expectancy, avgWin: all.avgWin, avgLoss: all.avgLoss, totalCharges: all.totalCharges, halves: [half((d) => d < mid), half((d) => d >= mid)], perDay };
}

function verdict(row, now) {
  if (row.trades < MIN_TRADES) return 'few';
  const more = row.totalNet > now.totalNet;
  const bothHalves = row.halves[0] >= now.halves[0] && row.halves[1] >= now.halves[1];
  if (more && bothHalves) return 'better';
  if (more) return 'mixed';
  return 'worse';
}

/**
 * The changes tried, each on top of your settings now. `rules` is what the test changes, `body` what the "Turn on" button saves
 * (PUT /api/auto): an entry rule goes under shareRules, the last entry time is the Account setting entryTo.
 */
const rule = (key, label, rules, extra = {}) => ({ key, label, rules, body: { shareRules: rules }, ...extra });
export const TRIES = [
  rule('marketAgree', 'Buy only with Nifty (no trades when Nifty is flat)', { marketAgree: true }),
  rule('minVsNifty', 'Share at least 0.3% stronger than Nifty', { minVsNifty: 0.3 }),
  rule('minRelVol', 'Volume at least 1.2x normal for the time', { minRelVol: 1.2 }),
  rule('confirmBar', 'Wait for a 5-minute close past the entry', { confirmBar: true }),
  rule('minStopPct', 'Allow stops from 0.3%', { minStopPct: 0.3 }),
  rule('minStop08', 'Only stops of 0.8% or more (fewer shares, lower charges)', { minStopPct: 0.8 }),
  rule('stopAfterLosses', 'No new trade after 2 losses in a day', { stopAfterLosses: 2 }),
  { key: 'until1130', label: 'No new trade after 11:30', rules: { entryTo: 690 }, body: { entryTo: 690 } },
  { key: 'until1230', label: 'No new trade after 12:30', rules: { entryTo: 750 }, body: { entryTo: 750 } },
  rule('lockR05', 'Profit lock in risks: from +0.5R keep +0.25R', { lockFromR: 0.5 }),
  rule('lockR035', 'Profit lock in risks: from +0.35R keep +0.2R', { lockFromR: 0.35 }),
  ...TRY_TARGETS.map((t) => rule(`target${t}`, `Sell at +₹${t} (no ladder)`, { target: t }, { target: t })),
];

/** Two "Turn on" bodies as one. */
const mergeBody = (a, b) => ({ ...a, ...b, ...(a.shareRules || b.shareRules ? { shareRules: { ...a.shareRules, ...b.shareRules } } : {}) });

/**
 * @param ideas     live-like ideas from replayStock({ live })
 * @param settings  the user's AutoSettings (minScore, skipSetups, trendScore, earlyNews, shareRules)
 * @param opts      { riskAmount, slippagePct, maxAmount }
 */
export function ruleTest(ideas, settings, opts) {
  const skip = new Set(settings?.skipSetups ?? []);
  const setupOn = (s) => !skip.has(s) && (s !== 'Trend score' || settings?.trendScore === true) && (s !== 'News gap' || settings?.earlyNews !== false);
  const minScore = settings?.minScore ?? 70;
  const nowRules = { ...shareRulesOf(settings?.shareRules), entryFrom: settings?.entryFrom ?? 555, entryTo: settings?.entryTo ?? 915 };
  const days = [...new Set(ideas.map((i) => DAY(i.openedAt)))].sort();
  const run = (rules) => summary(tradesFor(ideas, { minScore, setupOn, rules }), opts, days);
  const now = run(nowRules);
  const rows = TRIES.map((t) => {
    const rules = { ...nowRules, ...t.rules };
    const same = Object.entries(t.rules).every(([k, v]) => (k === 'entryTo' ? nowRules.entryTo <= v : nowRules[k] === v));
    const r = run(rules);
    return { key: t.key, label: t.label, target: t.target ?? null, patch: t.rules, body: t.body, alreadyOn: same, ...r, verdict: same ? 'on' : verdict(r, now) };
  });
  // Everything that was better on its own, together (the best fixed target only, if one was better).
  const good = rows.filter((r) => r.verdict === 'better');
  const isExit = (r) => r.target || r.patch?.lockFromR; // a fixed target and a lock in risks are both ways to sell: only the best one joins
  const bestTarget = good.filter(isExit).sort((a, b) => b.totalNet - a.totalNet)[0] ?? null;
  // of the rows that change the same setting (two stop sizes, two last entry times) only the one that made the most joins in
  const goodRules = good
    .filter((r) => !isExit(r))
    .sort((a, b) => b.totalNet - a.totalNet)
    .filter((r, i, list) => list.findIndex((x) => Object.keys(x.patch).join() === Object.keys(r.patch).join()) === i);
  let together = null;
  if (goodRules.length + (bestTarget ? 1 : 0) > 1) {
    const picked = [...goodRules, ...(bestTarget ? [bestTarget] : [])];
    const patch = Object.assign({}, ...picked.map((g) => g.patch));
    const r = run({ ...nowRules, ...patch });
    together = { label: `Together: ${picked.map((g) => g.label).join(' + ')}`, patch, body: picked.reduce((b, g) => mergeBody(b, g.body), {}), ...r, verdict: verdict(r, now) };
  }
  return {
    ideas: ideas.length,
    days,
    minScore,
    rules: nowRules,
    defaults: DEFAULT_SHARE_RULES,
    now: { label: 'Your settings now', ...now },
    rows,
    together,
    note: 'The replay has no order book and skips the scanner limits on open ideas and choppy-market pauses, so live results differ a little. A rule is "better" only when it made more money and was not worse in either half of the days.',
    ...(ideas.length && now.trades < MIN_TRADES ? { warning: `Only ${now.trades} trades with your settings now: too few to judge any rule. Run more days.` } : {}),
  };
}

