// The summary of the night research (scripts/research.js), as Markdown. Kept apart so it can be tested without a database.
export function researchReport(out, { email, took }) {
  const rs = (v) => (v == null || Number.isNaN(Number(v)) ? '-' : `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
  const pc = (v) => (v == null ? '-' : `${v}%`);
  const cell = (x) => String(x ?? '-').replace(/\|/g, '/').replace(/\n/g, ' ');
  const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') : '_none_');
  const tt = (p) => (p ? `${p.trades} / ${rs(p.net)}` : '-');
  const md = [];
  const h = (t) => md.push('', `## ${t}`, '');
  md.push(`# Night research, ${out.generatedAt.slice(0, 10)}`, '', `Account ${email}. Took ${took}. Nothing was changed or switched on. "Older" = the days it picked on, "Newest" = the days it never saw (trades / net).`);
  if (Object.keys(out.errors).length) md.push('', '**Parts that failed:**', ...Object.entries(out.errors).map(([k, e]) => `- ${k}: ${e}`));

  const o = out.parts.options;
  if (o) {
    h(`Options: period ${o.period?.from} to ${o.period?.to} (${o.period?.days} days, ${o.pricing?.mode ?? ''} prices)`);
    md.push('### Each indicator on its own (best 20 by net)', '');
    const ind = [...(o.indicators ?? [])].sort((a, b) => b.net - a.net);
    const row = (r) => [r.label, r.trades, pc(r.winRate), rs(r.net), rs(r.calls?.net ?? r.calls?.totalNet), rs(r.puts?.net ?? r.puts?.totalNet), r.halves ? `${rs(r.halves[0]?.net)} / ${rs(r.halves[1]?.net)}` : '-', r.verdict?.key ?? r.verdict ?? '-'];
    const head = ['Indicator', 'Trades', 'Win', 'Net', 'Calls', 'Puts', 'Older / newer half', 'Verdict'];
    md.push(table(head, ind.slice(0, 20).map(row)), '', '### Worst 10 indicators', '', table(head, ind.slice(-10).reverse().map(row)));
    md.push('', '### Your combinations and patterns as they are', '');
    md.push(table(['Entry', 'Trades', 'Win', 'Net', 'Older / newer half'], (o.techniques ?? []).filter((t) => t.combo || t.key === 'bot').map((t) => [t.label, t.trades, pc(t.winRate), rs(t.net ?? t.totalNet), t.halves ? `${rs(t.halves[0]?.net)} / ${rs(t.halves[1]?.net)}` : '-'])));
    if (o.autoFound?.found?.length) md.push('', '### Auto-find: pattern + filters that won on both parts', '', table(['Combination', 'Trades', 'Win', 'Net', 'Older', 'Newest'], o.autoFound.found.map((f) => [f.labels.join(' + '), f.trades, pc(f.winRate), rs(f.net), tt(f.train), tt(f.test)])));
    if (o.research?.bestExit || o.research?.bestStop) md.push('', '### Exits research (breakout + engulfing entries)', '', `- Best steady exit: ${o.research.bestExit?.label ?? '-'} (${rs(o.research.bestExit?.net)})`, `- Best steady stop: ${o.research.bestStop?.label ?? '-'} (${rs(o.research.bestStop?.net)})`);
  }
  const found = (title, f) => {
    if (!f) return;
    if (f.skipped) return md.push('', `### ${title}`, '', `Skipped: ${f.skipped}`);
    md.push('', `### ${title}`, '', `${f.tried ?? '?'} tried.`, '', table(['Combination', 'Trades', 'Win', 'Net', 'Calls', 'Puts', 'Older', 'Newest'], (f.found ?? []).slice(0, 20).map((x) => [x.labels.join(' + '), x.trades, pc(x.winRate), rs(x.net), rs(x.calls?.net ?? x.calls?.totalNet), rs(x.puts?.net ?? x.puts?.totalNet), tt(x.train), tt(x.test)])));
  };
  const anchors = (title, p) => {
    if (!p) return;
    if (p.skipped) return md.push('', `### ${title}`, '', `Skipped: ${p.skipped}`);
    const rows = (p.anchors ?? []).flatMap((a) => (a.found ?? []).slice(0, 3).map((x) => [`${a.label} + ${x.added.join(' + ')}`, x.trades, pc(x.winRate), rs(x.net), tt(x.train), tt(x.test)]));
    md.push('', `### ${title}`, '', `${p.tried ?? '?'} tried.`, '', table(['Combination', 'Trades', 'Win', 'Net', 'Older', 'Newest'], rows.slice(0, 30)));
  };
  const f1 = out.parts.optionsFind;
  if (f1) {
    h('Options: new combinations');
    found('Combination finder (best by profit)', f1.comboFound);
    anchors('Indicator + best partners (by profit)', f1.pairs);
    found('Highest win rate', f1.winFound);
  }
  if (out.parts.optionsWinRate) anchors('Indicator + best partners (by win rate)', out.parts.optionsWinRate.pairs);
  const texts = (x) => {
    const t = [];
    (function walk(v, depthLeft) {
      if (!v || depthLeft < 0 || t.length > 25) return;
      if (Array.isArray(v)) return v.slice(0, 10).forEach((y) => walk(y, depthLeft - 1));
      if (typeof v === 'object') for (const [k, y] of Object.entries(v)) (k === 'text' && typeof y === 'string' ? t.push(y) : walk(y, depthLeft - 1));
    })(x, 4);
    return [...new Set(t)];
  };
  for (const [key, title] of [['ladder', 'Ladder tester'], ['moved', 'Already-moved tester']]) {
    const r = out.parts[key];
    if (r) md.push('', `## ${title}`, '', ...texts(r).map((t) => `- ${t}`));
  }
  const s = out.parts.shares;
  if (s) {
    h('Shares');
    md.push(table(['Setup', 'Trades', 'Win', 'Net'], (s.combos ?? []).slice(0, 25).map((c) => [c.label ?? c.key, c.trades, pc(c.winRate), rs(c.totalNet ?? c.net)])));
    const ind = [...(s.indicators ?? [])].sort((a, b) => b.net - a.net);
    md.push('', '### Share indicators on their own (best 15)', '', table(['Indicator', 'Trades', 'Win', 'Net', 'Buys', 'Sells'], ind.slice(0, 15).map((r) => [r.label, r.trades, pc(r.winRate), rs(r.net), r.calls?.trades ?? '-', r.puts?.trades ?? '-'])));
  }
  const sf = out.parts.sharesFind;
  if (sf) {
    found('Shares: combination finder', sf.comboFound);
    anchors('Shares: indicator + best partners', sf.pairs);
  }
  h('Learn');
  const lc = out.parts.learn_combos;
  if (lc) md.push('### Each combination', '', ...((lc.list ?? lc.items ?? (Array.isArray(lc) ? lc : [])).map((c) => `- **${c.name ?? c.id}**: ${c.verdict ?? ''}. ${c.text ?? ''} ${(c.changes ?? []).map((x) => x.label).join('; ')}`)), ...(lc.error ? [`Error: ${lc.error}`] : []));
  const ls = out.parts.learn_setup;
  if (ls) md.push('', '### Whole setup', '', `${ls.verdict ?? ''}: ${ls.text ?? ''}`, ...((ls.changes ?? []).map((x) => `- ${x.label ?? x.key}`)));
  const lsh = out.parts.learn_shares;
  if (lsh) md.push('', '### Shares', '', `${lsh.verdict ?? ''}: ${lsh.text ?? ''}`, ...((lsh.changes ?? []).map((x) => `- ${x.label} (${x.from} → ${x.to})`)), ...(lsh.error ? [`Error: ${lsh.error}`] : []));
  md.push('', '---', 'Results on past days. Many things were tried, so some winners are luck: paper-trade before trusting any of them.');

  return md.join('\n');
}
