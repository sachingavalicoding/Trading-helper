// Words for the info button's "where it would have bought" chart (components/ExampleChart.jsx).

/** "09:35, Mon 3 Nov" in IST for an entry time in epoch seconds. */
export function entryClock(sec) {
  const d = new Date(sec * 1000);
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  const day = d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });
  return `${time}, ${day}`;
}

/** One sentence: how often it fired and how the index went next. */
export function exampleWords({ summary: s, days }) {
  if (!s.entries) return `It did not fire on the last ${days} days.`;
  const parts = [`${s.entries} entr${s.entries === 1 ? 'y' : 'ies'} in ${days} days (${s.calls} call${s.calls === 1 ? '' : 's'}, ${s.puts} put${s.puts === 1 ? '' : 's'})`];
  if (s.avgAfter != null) parts.push(`the index went the right way 30 minutes later ${s.right} times, on average ${s.avgAfter > 0 ? '+' : ''}${s.avgAfter} points (best move inside those 30 minutes ${s.avgBest > 0 ? '+' : ''}${s.avgBest} on average)`);
  return `${parts.join('; ')}.`;
}
