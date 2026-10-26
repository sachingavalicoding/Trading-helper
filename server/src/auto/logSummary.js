const round2 = (n) => Math.round(n * 100) / 100;
const sum = (list, f) => round2(list.reduce((s, x) => s + (f(x) || 0), 0));

/** "score 65 is below 70" and "score 62 is below 70" are one reason. */
const reasonKey = (r) => String(r || 'unknown').replace(/-?\d+(\.\d+)?/g, '#');

function group(list, keyOf) {
  const map = new Map();
  for (const e of list) map.set(keyOf(e), [...(map.get(keyOf(e)) || []), e]);
  return [...map].map(([key, rows]) => ({
    key,
    trades: rows.length,
    wins: rows.filter((e) => e.outcome.netPnl > 0).length,
    netPnl: sum(rows, (e) => e.outcome.netPnl),
    avgR: round2(rows.reduce((s, e) => s + (e.outcome.resultR || 0), 0) / rows.length),
  }));
}

/**
 * One day of the auto log, boiled down to the questions worth asking in the evening: what did it
 * place and how did those end, which setups and exits made or lost money, why did it skip, and
 * (for skipped ideas the scanner kept following) did the skips cost a winner or save a loser.
 * `ideas` maps idea id -> the scanner's own record of how that idea ended.
 */
export function summarizeLog(entries, ideas = new Map()) {
  const placed = entries.filter((e) => e.decision === 'PLACED');
  const closed = placed.filter((e) => e.status === 'CLOSED' && e.outcome);
  const skipped = entries.filter((e) => e.decision === 'SKIPPED');

  const reasons = new Map();
  for (const e of skipped) {
    const k = reasonKey(e.reason);
    const r = reasons.get(k) || { reason: k, count: 0, example: e.reason };
    r.count += 1;
    reasons.set(k, r);
  }

  const hindsight = { followed: 0, wouldHitTarget: 0, wouldStop: 0, unresolved: 0 };
  for (const e of skipped) {
    const idea = e.idea && ideas.get(String(e.idea));
    if (!idea) continue;
    hindsight.followed += 1;
    if (idea.status === 'TARGET_HIT') hindsight.wouldHitTarget += 1;
    else if (idea.status === 'STOPPED') hindsight.wouldStop += 1;
    else hindsight.unresolved += 1;
  }

  const wins = closed.filter((e) => e.outcome.netPnl > 0).length;
  return {
    considered: entries.length,
    placed: placed.length,
    skipped: skipped.length,
    open: placed.filter((e) => e.status === 'OPEN').length,
    closed: closed.length,
    wins,
    losses: closed.length - wins,
    grossPnl: sum(closed, (e) => e.outcome.grossPnl),
    charges: sum(closed, (e) => e.outcome.charges),
    netPnl: sum(closed, (e) => e.outcome.netPnl),
    avgMinutesHeld: closed.length ? Math.round(closed.reduce((s, e) => s + (e.outcome.minutesHeld || 0), 0) / closed.length) : null,
    // trades that were in profit by half the risk at some point but still ended as a loss: exits too late
    gaveBack: closed.filter((e) => (e.outcome.bestR ?? 0) >= 0.5 && e.outcome.netPnl <= 0).length,
    byExit: group(closed, (e) => e.outcome.exitReason),
    bySetup: group(closed, (e) => e.setup || 'unknown'),
    byScore: group(closed, (e) => (e.score >= 80 ? '80+' : e.score >= 75 ? '75-79' : '70-74')),
    skipReasons: [...reasons.values()].sort((a, b) => b.count - a.count),
    skippedHindsight: hindsight,
  };
}
