const MIN_CALLS = 5; // fewer decided calls than this say nothing

export const VERDICT = {
  HIT: { text: 'Hit', tone: 'up' },
  MISS: { text: 'Miss', tone: 'down' },
  FLAT: { text: 'Flat', tone: 'muted' },
};

/** A signed % for a table cell: +1.25% / -0.40%, a dash when there is none. */
export const pctText = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);

const best = (rows, by) => rows.reduce((a, r) => (a == null || by(r) > by(a) ? r : a), null);

/**
 * Plain-English lines from the techniques report: what earned the most, what lost, which chart check made
 * the biggest difference and which kind of news the market followed. Each says how much data stands behind it.
 */
export function takeaways(report) {
  const out = [];
  if (!report) return out;
  const { scanner, news, trades } = report;

  const fam = (scanner?.byFamily || []).filter((f) => f.count >= MIN_CALLS);
  if (fam.length) {
    const top = best(fam, (f) => f.totalR ?? -99);
    const worst = fam.length > 1 ? best(fam, (f) => -(f.totalR ?? 99)) : null;
    out.push(`${top.key} made the most: ${top.totalR >= 0 ? '+' : ''}${top.totalR}R over ${top.count} ideas (${top.winRate}% reached target 1).`);
    if (worst && worst.key !== top.key && worst.totalR < 0) out.push(`${worst.key} lost the most: ${worst.totalR}R over ${worst.count} ideas.`);
  }

  const checks = (scanner?.byCheck || []).filter((c) => c.liftR != null && c.withoutCount >= MIN_CALLS);
  if (checks.length) {
    const top = best(checks, (c) => c.liftR);
    if (top.liftR > 0) out.push(`${top.label} helped most: ideas it supported averaged ${top.withAvgR}R against ${top.withoutAvgR}R without it.`);
    const rsi = checks.find((c) => c.id === 'rsi');
    if (rsi && rsi.id !== top.id) out.push(`RSI: ${rsi.withAvgR}R when it supported the trade, ${rsi.withoutAvgR}R when it did not.`);
  }

  const cats = (news?.byCategory || []).filter((c) => c.hits + c.misses >= MIN_CALLS);
  if (cats.length) {
    const top = best(cats, (c) => c.avgEdgePct);
    if (top.avgEdgePct > 0) out.push(`News about ${top.key.toLowerCase().replace('_', ' ')} was followed by the price ${top.hitRate}% of the time (${top.avgEdgePct >= 0 ? '+' : ''}${top.avgEdgePct}% from open to close on average).`);
    const worst = best(cats, (c) => -c.avgEdgePct);
    if (worst.key !== top.key && worst.avgEdgePct < 0) out.push(`News about ${worst.key.toLowerCase().replace('_', ' ')} did not hold: the price went the other way ${100 - worst.hitRate}% of the time.`);
  }

  const setups = (trades?.equity?.bySetup || []).filter((s) => s.trades >= 3);
  if (setups.length) {
    const top = best(setups, (s) => s.netPnl);
    out.push(`Your auto trades: ${top.key} earned ₹${Math.round(top.netPnl).toLocaleString('en-IN')} net over ${top.trades} trades.`);
  }

  if (!out.length) out.push('Not enough finished calls yet. Keep the paper test running; a few days of results are noise.');
  return out;
}

/** Shift a YYYY-MM-DD date by `n` days. */
export function shiftDay(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
