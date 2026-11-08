import { formatPnl as rawPnl } from './format.js';

const formatPnl = (v) => rawPnl(Math.round(v));

export const LAB_DAYS = [
  { value: '10', label: '10 days' },
  { value: '15', label: '15 days' },
  { value: '30', label: '30 days' },
];

export const LAB_PRICES = [
  { value: 'mixed', label: 'Real where saved' },
  { value: 'real', label: 'Real only' },
  { value: 'estimated', label: 'Estimated' },
];

/** The request for the lab: the start, up to three added checks, how many days and which premiums. */
export function labPath({ base, add = [], days = 22, prices = 'mixed', noStop = null, segment = 'options', edit = null }) {
  const q = new URLSearchParams(segment === 'shares' ? { segment, base, days: String(days) } : { base, days: String(days), prices });
  if (add.length) q.set('add', add.join(','));
  if (edit) q.set('edit', JSON.stringify(edit)); // order settings tried in place of the saved ones
  if (segment === 'shares') return `/lab?${q}`;
  if (noStop) {
    // the no-stop test: no stop loss, only a fixed profit lock (and the emergency floor at half the premium)
    q.set('noStop', '1');
    if (Number(noStop.at) > 0) {
      q.set('lockAt', String(Number(noStop.at)));
      q.set('lockKeep', String(Number(noStop.keep) || 0));
    }
  }
  return `/lab?${q}`;
}

/** Adds or removes a check from the picks, keeping the three most recent. */
export const togglePick = (add, key, max = 3) => (add.includes(key) ? add.filter((k) => k !== key) : [...add, key].slice(-max));

/** "21 Oct 10:35" from epoch seconds, in IST. */
export function whenText(sec) {
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sec * 1000));
  return d.replace(',', '');
}

export const EXIT_WORD = { STOP: 'Stop hit', LOCK: 'Profit lock', TRAIL: 'Trailing stop', BREAKEVEN: 'Break-even', TARGET: 'Target', EOD: 'Closing time', HARD: 'Hard stop', FLOOR: 'Emergency floor', SQUARE_OFF: 'Closing time' };
export const exitWord = (r) => EXIT_WORD[r] ?? r;

/** One line on what a check would have done to the entries: "skips 3 (2 losers ₹-4,100, 1 winner ₹900), adds 0". */
export function addonLine(a) {
  const r = a.removed;
  const parts = [];
  if (r.trades) parts.push(`skips ${r.trades}: ${r.losers} loser${r.losers === 1 ? '' : 's'} ${formatPnl(r.losersNet)}${r.winners ? `, ${r.winners} winner${r.winners === 1 ? '' : 's'} ${formatPnl(r.winnersNet)}` : ''}`);
  if (a.added.trades) parts.push(`adds ${a.added.trades} (${formatPnl(a.added.net)})`);
  return parts.join(' · ');
}

/** What would have skipped a losing entry, in a sentence. */
export function fixLine(f) {
  const cost = f.winnersLost ? `also skips ${f.winnersLost} winner${f.winnersLost === 1 ? '' : 's'} (${formatPnl(f.winnersLostNet)})` : 'skips no winner';
  return `${f.label}: ${cost}, net ${f.gain >= 0 ? 'better' : 'worse'} by ${formatPnl(Math.abs(f.gain)).replace(/^[+-]/, '')}`;
}

/** Chart arrows for the entries: green/red by result, grey when the picked check would have skipped it. `selected` is drawn larger. */
export function entryMarkers(entries, colors, selected = null) {
  const out = [];
  for (const e of entries) {
    const call = e.side === 'CE';
    const gone = e.status === 'removed';
    const color = gone ? colors.muted : e.net > 0 ? colors.up : colors.down;
    out.push({ id: e.id, time: e.entryTime - 300, position: call ? 'belowBar' : 'aboveBar', shape: call ? 'arrowUp' : 'arrowDown', color, size: e.id === selected ? 2 : 1, text: `${gone ? '✕ ' : e.status === 'added' ? '+ ' : ''}${Math.round(e.net)}` });
    if (e.id === selected) out.push({ id: `${e.id}:exit`, time: e.exitTime - 60, position: call ? 'aboveBar' : 'belowBar', shape: 'circle', color, text: exitWord(e.reason) });
  }
  return out;
}

/** An SVG path for an equity line: points are { time, net }; a start at zero is added. */
export function equityPath(points, { w = 320, h = 90, pad = 4, min = null, max = null } = {}) {
  if (!points?.length) return '';
  const xs = points.map((p) => p.time);
  const ys = [0, ...points.map((p) => p.net)];
  const lo = min ?? Math.min(...ys);
  const hi = max ?? Math.max(...ys);
  const x0 = Math.min(...xs);
  const dx = Math.max(Math.max(...xs) - x0, 1);
  const dy = Math.max(hi - lo, 1);
  const px = (t) => pad + ((t - x0) / dx) * (w - 2 * pad);
  const py = (v) => h - pad - ((v - lo) / dy) * (h - 2 * pad);
  return `M${px(x0).toFixed(1)},${py(0).toFixed(1)} ${points.map((p) => `L${px(p.time).toFixed(1)},${py(p.net).toFixed(1)}`).join(' ')}`;
}

/** The common vertical range of several equity lines, so two lines can be compared on one chart. */
export function equityRange(...lines) {
  const ys = [0, ...lines.flatMap((l) => (l || []).map((p) => p.net))];
  return { min: Math.min(...ys), max: Math.max(...ys) };
}

const clock = (sec) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(sec * 1000));
const rs = (v) => `₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
const px = (v) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** Why the entry was taken, in plain words: which checks held on the bar that just closed, what was bought and where the stop sat. */
export function entryStory(e) {
  const call = e.side === 'CE';
  const held = (e.why || []).filter((w) => w.held).map((w) => w.label);
  const why = held.length ? `${held.join(' and ')} ${held.length > 1 ? 'all held' : 'held'} on the 5-minute bar that had just closed` : e.note ? `the pattern "${e.note}" formed on the 5-minute bar that had just closed` : 'the entry rule fired on the bar that had just closed';
  const gap = Math.abs(e.entrySpot - e.stop);
  const stop = e.noStop ? 'There was no stop loss (the no-stop test): only the profit lock, the emergency floor at half the premium, and the closing time could sell it.' : `The stop sat on the index at ${px(e.stop)}, ${Math.round(gap)} points ${call ? 'below' : 'above'} the entry.`;
  return `At ${clock(e.entryTime)} ${why}, so it bought ${e.lots} lot${e.lots > 1 ? 's' : ''} of the ${e.strike} ${call ? 'call' : 'put'} at ${rs(e.entryPremium)} (${e.priced === 'real' ? 'real saved price' : 'estimated price'}) with the index at ${px(e.entrySpot)}. ${stop}`;
}

/** How the entry ended, in plain words, with the numbers. */
export function exitStory(e) {
  const at = clock(e.exitTime);
  const sold = `${rs(e.exitPremium)} with the index at ${px(e.exitSpot)}`;
  const how = {
    STOP: `At ${at} the index reached the stop at ${px(e.stop)}, so the option was sold at about ${sold}.`,
    BREAKEVEN: `The trade had moved in its favour, so the stop was moved up to the entry price. At ${at} the index came back to it and the option was sold at about ${sold}.`,
    TRAIL: `The trailing stop follows the best price. At ${at} the index fell back to it and the option was sold at about ${sold}.`,
    LOCK: `The profit ladder raised its lock level as the profit grew. At ${at} the price fell back to that level and the option was sold at about ${sold}.`,
    HARD: `At ${at} the option fell faster than the index stop could act, so the hard stop sold it at about ${sold}.`,
    FLOOR: `With no stop loss, the option kept falling until at ${at} it had lost half the money paid for it, so the emergency floor sold it at about ${sold}.`,
    TARGET: `At ${at} the profit target was reached and the option was sold at about ${sold}.`,
    EOD: `It was still open at the closing time, so at ${at} the option was sold at about ${sold}.`,
  }[e.reason] ?? `Sold at ${at} (${e.reason}) at about ${sold}.`;
  const result = e.net > 0 ? `Won ${rs(e.net)} after ${rs(e.charges)} charges.` : `Lost ${rs(e.net)} including ${rs(e.charges)} charges.`;
  return `${how} Held ${e.minutes} minute${e.minutes === 1 ? '' : 's'}; at its best it showed ${rs(e.best)} up and at its worst ${rs(e.worst)} down. ${result}`;
}

/** "Mon 5 Oct" from a day key. */
export function dayWord(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Why a share entry was taken and how it was sized, in plain words. */
export function shareEntryStory(e) {
  const buy = e.side === 'CE';
  const held = (e.why || []).filter((w) => w.held).map((w) => w.label);
  const why = held.length ? `${held.join(' and ')} ${held.length > 1 ? 'all held' : 'held'} on the 5-minute bar of ${e.symbol} that had just closed` : `the check turned true on the 5-minute bar of ${e.symbol} that had just closed`;
  const gap = Math.abs(e.entry - e.stopLoss);
  return `At ${clock(e.entryTime)} ${why}, so it ${buy ? 'bought' : 'sold short'} ${e.qty} shares at ${px(e.entry)} (${rs(e.amount)} in the trade). The stop sat at ${px(e.stopLoss)}, ${px(gap)} (${((gap / e.entry) * 100).toFixed(2)}%) ${buy ? 'below' : 'above'}, so a stop-out would lose about ${rs(e.risk)} before charges.`;
}

/** How a share entry ended, in plain words. */
export function shareExitStory(e) {
  const at = clock(e.exitTime);
  const how = {
    STOP: `At ${at} the price reached the stop and it was closed at about ${px(e.exitPrice)}.`,
    LOCK: `The profit lock had raised the stop as the profit grew. At ${at} the price came back to it and it was closed at about ${px(e.exitPrice)}.`,
    TARGET: `At ${at} the profit target was reached and it was closed at ${px(e.exitPrice)}.`,
    SQUARE_OFF: `It was still open at the closing time, so at ${at} it was closed at about ${px(e.exitPrice)}.`,
  }[e.reason] ?? `Closed at ${at} (${e.reason}) at about ${px(e.exitPrice)}.`;
  const result = e.net > 0 ? `Won ${rs(e.net)} after ${rs(e.charges)} charges.` : `Lost ${rs(e.net)} including ${rs(e.charges)} charges.`;
  return `${how} Held ${e.minutes} minute${e.minutes === 1 ? '' : 's'}. ${result}`;
}
