// Rule-based headline tagging. It is deliberately simple and explainable: every tag comes with
// the phrases that caused it. A model (Gemini, later Claude) can replace `tagHeadline` behind the
// same return shape; see NewsService's `tagger` option.

const UP = 'jumps?|surges?|soars?|rises?|rose|climbs?|grows?|grew|spikes?|doubles?|improves?|rallies|swells?|up';
const DOWN = 'falls?|fell|drops?|dropped|declines?|slumps?|plunges?|dips?|slips?|tumbles?|sinks?|shrinks?|down|halves';

// [pattern, weight, category, reason]
const RULES = [
  [/\b(beats?|tops?|surpass(?:es)?|exceeds?)\b.{0,20}\b(estimates?|expectations?|forecasts?)\b|\bbetter than expected\b|\brecord (?:quarterly )?(?:profit|revenue|sales|earnings)\b/i, 2, 'RESULTS', 'Results beat expectations'],
  [new RegExp(`\\b(?:net )?(?:profit|pat|earnings|revenue|income|ebitda)\\b.{0,30}\\b(?:${UP})\\b`, 'i'), 2, 'RESULTS', 'Profit or revenue is growing'],
  [/\b(misses?|lags?|trails?|falls? short of|below)\b.{0,20}\b(estimates?|expectations?|forecasts?)\b|\bworse than expected\b|\bdisappoint/i, -2, 'RESULTS', 'Results missed expectations'],
  [new RegExp(`\\b(?:net )?(?:profit|pat|earnings|revenue|income|ebitda|margins?)\\b.{0,30}\\b(?:${DOWN})\\b`, 'i'), -2, 'RESULTS', 'Profit or revenue is falling'],
  [/\b(posts?|reports?|swings? to|widens?)\b.{0,15}\bloss\b|\bnet loss\b|\bloss widens\b/i, -2, 'RESULTS', 'The company is making a loss'],
  [/\b(wins?|bags?|secures?|lands?|gets?|receives?|clinches?)\b.{0,25}\b(orders?|contracts?|deals?|projects?|tenders?)\b|\border (?:win|book)\b/i, 2, 'ORDER_WIN', 'New order or contract won'],
  [/\b(upgrade[sd]?|raises? (?:target|rating)|initiates? (?:coverage )?with (?:a )?buy|outperform|overweight|top pick)\b|\bbuy rating\b/i, 1.5, 'BROKERAGE', 'Brokerage upgrade or buy call'],
  [/\b(downgrade[sd]?|cuts? (?:target|rating)|underperform|underweight|reduce rating)\b|\bsell rating\b/i, -1.5, 'BROKERAGE', 'Brokerage downgrade or sell call'],
  [/\b(dividend|bonus (?:issue|shares?)|buy-?back|stock split)\b/i, 1, 'CORPORATE', 'Dividend, bonus or buyback'],
  [/\b(acquires?|acquisition|merger|takeover|joint venture|strategic partnership|stake buy)\b/i, 0.5, 'DEAL', 'Acquisition or partnership news'],
  [/\b(fraud|scam|probe|raids?|sebi (?:notice|order|penalty|bars?)|penalty|fined?|show[- ]cause|default(?:s|ed)?|insolvency|bankruptcy|cbi|enforcement directorate|money laundering)\b/i, -2, 'REGULATORY', 'Regulatory, legal or default risk'],
  [/\b(ceo|cfo|md|chairman|auditor|independent director)\b.{0,15}\b(resigns?|quits?|steps down|exits?)\b/i, -1.5, 'MANAGEMENT', 'Top management exit'],
  [/\b(fire|explosion|shutdown|plant (?:closure|halt)|strike|recall|outage|cyber ?attack|data breach)\b/i, -1.5, 'OPERATIONS', 'Operational disruption'],
  [/\b(tariff|import ban|export ban|ban on|price cap|windfall tax|duty hike)\b/i, -1, 'POLICY', 'Adverse policy move'],
  [/\b(approval|approved by|usfda (?:nod|approval)|clearance|licen[cs]e (?:granted|win))\b/i, 1, 'POLICY', 'Approval or clearance received'],
  [new RegExp(`\\b(?:shares?|stock)\\b.{0,25}\\b(?:hits?|touch(?:es)?|at) (?:a )?(?:record|52-week|all-time|fresh) high\\b|\\bsurges?\\b|\\brallies\\b`, 'i'), 1, 'PRICE_MOVE', 'The price has already jumped'],
  [new RegExp(`\\b(?:shares?|stock)\\b.{0,25}\\b(?:hits?|touch(?:es)?|at) (?:a )?(?:52-week|all-time|fresh) low\\b|\\bplunges?\\b|\\btanks?\\b|\\bcrash(?:es)?\\b|\\bslumps?\\b`, 'i'), -1, 'PRICE_MOVE', 'The price has already dropped'],
  [/\b(raises?|hikes?|lifts?|upgrades?)\b.{0,15}\b(guidance|outlook|forecast)\b|\bstrong (?:demand|outlook|guidance)\b/i, 1.5, 'GUIDANCE', 'Management raised its outlook'],
  [/\b(cuts?|lowers?|trims?|slashes?)\b.{0,15}\b(guidance|outlook|forecast)\b|\bweak (?:demand|outlook|guidance)\b|\bdemand (?:slowdown|slump)\b/i, -1.5, 'GUIDANCE', 'Management cut its outlook'],
  [/\b(promoter|promoters)\b.{0,25}\b(pledge|sell|sells|offload|stake sale)\b|\bblock deal\b.{0,20}\b(sell|sold|offload)/i, -1.5, 'PROMOTER', 'Promoters or big holders are selling'],
  [/\b(promoter|promoters)\b.{0,25}\b(buy|buys|raises? stake|increases? stake)\b|\b(fii|fpi|dii|mutual funds?)\b.{0,20}\b(buy|buys|raise|increase|bought)\b/i, 1, 'PROMOTER', 'Promoters or big investors are buying'],
  [/\b(capacity expansion|capex plan|new plant|commissions?|launches?)\b/i, 0.5, 'GROWTH', 'Expansion or new launch'],
  [/\b(price hike|raises? prices|volume growth|market share gain)\b/i, 1, 'GROWTH', 'Pricing power or growing volumes'],
  [/\b(layoffs?|job cuts|loses? (?:key )?client|client loss|order cancell?ed|contract cancell?ed)\b/i, -1.5, 'OPERATIONS', 'Lost business or layoffs'],
];

const QUESTION = /^(will|can|should|is|are|does|why|what|how)\b|\?\s*$/i;

/**
 * Score one headline from -3 (very bearish) to +3 (very bullish).
 * Returns { sentiment, label, category, reasons } where `reasons` are plain-English causes.
 */
export function tagHeadline(title) {
  let sum = 0;
  let best = null;
  const reasons = [];
  for (const [re, w, category, reason] of RULES) {
    if (!re.test(title)) continue;
    sum += w;
    reasons.push(reason);
    if (!best || Math.abs(w) > Math.abs(best.w)) best = { w, category };
  }
  // Questions and "may/could" headlines are speculation, so count them for less.
  if (QUESTION.test(title.trim()) || /\b(may|might|could|likely to|eyes?|plans?|set to|expected to)\b/i.test(title)) sum *= 0.4;
  const sentiment = Math.max(-3, Math.min(3, Math.round(sum * 10) / 10));
  const label = sentiment >= 1 ? 'BULLISH' : sentiment <= -1 ? 'BEARISH' : 'NEUTRAL';
  return { sentiment, label, category: best?.category || 'GENERAL', reasons };
}
