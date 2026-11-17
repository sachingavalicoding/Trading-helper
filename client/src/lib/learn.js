// @ts-check
// Words and choices for Lab > Learn (components/lab/LearnLab.jsx). Kept apart from the screen so they can be tested.

export const LEARN_DAYS = [
  { value: '15', label: '15 days' },
  { value: '20', label: '20 days' },
  { value: '30', label: '30 days' },
];

/** The coloured box at the top of a result: tone, title, and whether Apply is open, needs a confirmation, or is not offered. */
export function verdictBox(last) {
  if (!last) return null;
  switch (last.verdict) {
    case 'passed':
      return { tone: 'up', title: 'Passed', apply: 'open' };
    case 'failed':
      return { tone: 'down', title: 'Failed', apply: 'confirm' };
    case 'same':
      return { tone: 'muted', title: 'No better settings found', apply: 'none' };
    case 'short':
      return { tone: 'warn', title: 'Not enough days', apply: 'none' };
    default:
      return { tone: 'down', title: 'Could not run', apply: 'none' };
  }
}

/** What the Apply button does now: 'apply', 'confirm' (failed: Apply anyway after a question), or null with the reason it is not there. */
export function applyState(last) {
  const box = verdictBox(last);
  if (!box || box.apply === 'none') return { action: null, why: null };
  if (last.applied && !last.undone) return { action: null, why: 'Applied. Undo puts your old settings back.' };
  if (last.undone) return { action: null, why: 'Undone: your old settings are back.' };
  if (last.stale) return { action: null, why: 'Your settings changed after this run. Run Learn again.' };
  return { action: box.apply === 'open' ? 'apply' : 'confirm', why: null };
}

const rupees = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v ?? 0)).toLocaleString('en-IN')}`;

/** One line for a window row: "Last 10 days (5 hidden)". */
export function windowTitle(w) {
  const hidden = w.hidden === w.days ? 'all hidden' : w.hidden ? `${w.hidden} hidden, ${w.days - w.hidden} learned on` : 'all learned on';
  return `Last ${w.days} days (${hidden})`;
}

/** The difference new minus old, as words with a sign: "+₹1,200" or "-₹300" or "same". */
export function diffWord(neu, old) {
  const d = Math.round((neu ?? 0) - (old ?? 0));
  if (!d) return 'same';
  return `${d > 0 ? '+' : '-'}${rupees(Math.abs(d))}`;
}

/** The rows of the old-vs-new table for one result part ({ old, new } steady stats). */
export function compareRows(part) {
  if (!part?.old || !part?.new) return [];
  const { old, new: neu } = part;
  const pct = (x) => (x == null ? '–' : `${x}%`);
  const ratio = (x) => (x == null ? '–' : x.toFixed(2));
  return [
    { key: 'net', label: 'Profit after charges', old: rupees(old.net), new: rupees(neu.net), better: neu.net > old.net, worse: neu.net < old.net },
    { key: 'score', label: 'Steady score (₹ a day)', old: rupees(old.score), new: rupees(neu.score), better: neu.score > old.score, worse: neu.score < old.score },
    { key: 'badDays', label: 'Losing days', old: `${old.badDays} of ${old.days}`, new: `${neu.badDays} of ${neu.days}`, better: neu.badDays < old.badDays, worse: neu.badDays > old.badDays },
    { key: 'worstDay', label: 'Worst day', old: rupees(old.worstDay), new: rupees(neu.worstDay), better: neu.worstDay > old.worstDay, worse: neu.worstDay < old.worstDay },
    { key: 'payoff', label: 'Win/loss ratio', old: ratio(old.payoff), new: ratio(neu.payoff), better: (neu.payoff ?? 0) > (old.payoff ?? 0), worse: (neu.payoff ?? 0) < (old.payoff ?? 0) },
    { key: 'winRate', label: 'Trades won', old: `${pct(old.winRate)} of ${old.trades}`, new: `${pct(neu.winRate)} of ${neu.trades}`, better: false, worse: false },
  ];
}

/** Groups the learned changes by what they touch, in a fixed order. */
export function groupChanges(changes = []) {
  const order = ['Combinations', 'Indicators', 'Limits', 'Stop loss', 'Profit ladder', 'Entry hours'];
  const map = new Map();
  for (const c of changes) map.set(c.group, [...(map.get(c.group) ?? []), c]);
  return [...map.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([group, list]) => ({ group, list }));
}

/** The split line: which days it learned on and which it kept hidden. */
export function splitLine(last) {
  const s = last?.split;
  if (!s) return '';
  const prices = last.pricing === 'real' ? 'real saved option prices' : 'estimated option prices (too few real ones saved)';
  return `Learned on ${s.learnDays} days (${s.from} to the day before ${s.hiddenFrom}), then replayed old and new settings on the newest ${s.hiddenDays} days (${s.hiddenFrom} to ${s.to}) it never saw. ${last.tried} settings tried, ${prices}.`;
}

/** Why the Learn card could not be read, in words: a server still on the old code answers "not found". */
export function loadErrorText(e) {
  if (e?.status === 404) return 'The app server is still running the old code, so Learn is not there yet. Stop the server (Ctrl+C in Termux), run ./start.sh again, then reload this page.';
  if (e?.status === 0 || /fetch|network/i.test(e?.message ?? '')) return 'Could not reach the app server. Check that ./start.sh is running in Termux, then tap Try again.';
  return `Could not load Learn: ${e?.message || 'unknown error'}`;
}

/** The line under the button while a run is going: the step and how long it has run. */
export function runningText(status) {
  const secs = status?.seconds ?? 0;
  const took = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
  return `${status?.step || 'Starting'} · ${took} so far. It takes a few minutes (it stops trying new changes after 3); you can leave this page and come back.`;
}
