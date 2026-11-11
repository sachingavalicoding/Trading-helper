import { ruleBlock, shareRulesOf } from '../scanner/entryRules.js';
import { istParts } from '../market/marketHours.js';

// "What could have skipped it" on a share auto trade (added 11 Nov 2026): every entry rule tried on this one trade, at the value the
// Shares study liked, with whether that rule is on in your settings now. Plus the score parts that agreed on this trade although the
// 10-day study (11 Nov) found that ideas where they agree did worse: a sign of a late entry. Pure, so it is tested without a database.

/** The values the 10-15 day Shares studies of 11 Nov favoured. */
export const SUGGESTED = Object.freeze({ minScore: 80, entryTo: 690, minStopPct: 0.8, marketAgree: true, minVsNifty: 0.3, minRelVol: 1.2, noChaseR: 0.5, stopAfterLosses: 2 });

/** Score parts whose "agrees" went with worse results in the 10-day Shares study (11 Nov 2026), worst first. */
export const LATE_SIGNS = ['mfi', 'pivotR1', 'volume', 'rsi', 'ultimate', 'donchian', 'adx'];

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * @param log       the AutoLog row of the trade (setup, side, score, entry, stopLoss, fillPrice, card { facts, checks }, createdAt)
 * @param settings  the user's AutoSettings now (minScore, entryTo, shareRules)
 * @param lossesBefore losing auto share trades of that day that had closed before this one was bought
 * @param net       the trade's net result, or null while open
 * @param entryTime unix seconds of the buy (else the log's time)
 */
export function shareSkips({ log, settings = {}, lossesBefore = 0, net = null, entryTime = null }) {
  if (!log || log.segment === 'OPT') return null;
  const sr = shareRulesOf(settings.shareRules);
  const f = log.card?.facts ?? log.detail?.facts ?? {};
  const side = log.side;
  const d = side === 'BUY' ? 1 : -1;
  const risk = Math.abs(log.entry - log.stopLoss);
  const stopPct = f.stopPct ?? (log.entry ? (risk / log.entry) * 100 : null);
  const at = entryTime != null ? istParts(new Date(entryTime * 1000)).minutes : log.createdAt ? istParts(new Date(log.createdAt)).minutes : null;
  const chasedR = log.fillPrice != null && risk ? (d * (log.fillPrice - log.entry)) / risk : null;
  const minScore = settings.minScore ?? 70;
  const entryTo = settings.entryTo ?? 915;

  const row = (key, label, value, skip, on, rule) => ({ key, label, value, skip, on, rule });
  const rules = [
    row('score', 'Score 80 or more', log.score != null ? `score ${log.score}` : 'no score', log.score != null ? log.score < SUGGESTED.minScore : null, minScore >= SUGGESTED.minScore, `yours: ${minScore}+`),
    row('time', 'No new trade after 11:30', at != null ? `bought at ${hhmm(at)}` : 'time unknown', at != null ? at >= SUGGESTED.entryTo : null, entryTo <= SUGGESTED.entryTo, `yours: until ${hhmm(entryTo)}`),
    row('stop', 'Stop at least 0.8% away', stopPct != null ? `stop ${stopPct.toFixed(2)}% away` : 'stop unknown', stopPct != null ? stopPct < SUGGESTED.minStopPct : null, sr.minStopPct >= SUGGESTED.minStopPct, `yours: ${sr.minStopPct || 'off'}${sr.minStopPct ? '%' : ''}`),
    row('nifty', 'Nifty must agree', f.niftyTrend == null ? 'no Nifty reading' : `Nifty ${f.niftyTrend > 0 ? 'trending up' : f.niftyTrend < 0 ? 'trending down' : 'flat'}`, f.niftyTrend == null ? null : Boolean(ruleBlock({ marketAgree: true }, f, side)), sr.marketAgree === true, `yours: ${sr.marketAgree ? 'on' : 'off'}`),
    row('strength', 'At least 0.3% stronger than Nifty', f.relStrength == null ? 'no reading' : `${(d * f.relStrength).toFixed(2)}% ${d > 0 ? 'stronger' : 'weaker'} than Nifty`, f.relStrength == null ? null : Boolean(ruleBlock({ minVsNifty: SUGGESTED.minVsNifty }, f, side)), sr.minVsNifty >= SUGGESTED.minVsNifty, `yours: ${sr.minVsNifty || 'off'}${sr.minVsNifty ? '%' : ''}`),
    row('volume', 'Volume at least 1.2x normal', f.relVol == null ? 'no reading' : `volume ${f.relVol.toFixed(1)}x normal`, f.relVol == null ? null : Boolean(ruleBlock({ minRelVol: SUGGESTED.minRelVol }, f, side)), sr.minRelVol >= SUGGESTED.minRelVol, `yours: ${sr.minRelVol || 'off'}${sr.minRelVol ? 'x' : ''}`),
    row('chase', 'Not bought more than 0.5R past the entry', chasedR == null ? 'fill unknown' : `bought ${chasedR.toFixed(2)}R past the entry`, chasedR == null ? null : chasedR > SUGGESTED.noChaseR, sr.noChaseR > 0 && sr.noChaseR <= SUGGESTED.noChaseR, `yours: ${sr.noChaseR || 'off'}${sr.noChaseR ? 'R' : ''}`),
    row('losses', 'No new trade after 2 losses that day', `${lossesBefore} losing trade${lossesBefore === 1 ? '' : 's'} before it`, lossesBefore >= SUGGESTED.stopAfterLosses, sr.stopAfterLosses > 0 && sr.stopAfterLosses <= SUGGESTED.stopAfterLosses, `yours: ${sr.stopAfterLosses || 'off'}`),
  ];

  const checks = Array.isArray(log.card?.checks) ? log.card.checks : [];
  const late = LATE_SIGNS.map((k) => checks.find((c) => c.key === k && c.max > 0 && c.points >= c.max)).filter(Boolean).map((c) => ({ key: c.key, label: c.label, text: c.text }));

  const skipping = rules.filter((r) => r.skip === true);
  const offButWould = skipping.filter((r) => !r.on);
  const lost = net != null && net < 0;
  let text;
  if (!skipping.length) text = lost ? 'None of the entry rules would have skipped this trade: it passed every one, and still lost.' : 'It passed every entry rule.';
  else if (lost && offButWould.length) text = `${skipping.length} rule${skipping.length === 1 ? '' : 's'} would have skipped this loss. ${offButWould.length === skipping.length ? 'All of them are' : `${offButWould.length} of them ${offButWould.length === 1 ? 'is' : 'are'}`} off in your settings now: ${offButWould.map((r) => r.label).join(', ')}.`;
  else if (lost) text = `${skipping.length} rule${skipping.length === 1 ? '' : 's'} would have skipped this loss, and ${skipping.length === 1 ? 'it is' : 'they are'} on now, so a trade like it is skipped from now on.`;
  else text = `${skipping.length} rule${skipping.length === 1 ? '' : 's'} would have skipped this trade too, so a rule can also cost a winner.`;
  return { rules, late, text, lost };
}
