import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { formatPnl, pnlClass } from '../../lib/format.js';
import { Badge, Card } from '../ui.jsx';

const VERDICT = {
  better: { text: 'Better', cls: 'text-up' },
  mixed: { text: 'Lucky days only', cls: 'text-warn' },
  worse: { text: 'Worse', cls: 'text-down' },
  few: { text: 'Too few trades', cls: 'text-muted' },
  on: { text: 'Already on', cls: 'text-muted' },
};

function Row({ x, onUse, busy }) {
  const v = VERDICT[x.verdict];
  return (
    <li className="space-y-0.5 py-2 text-xs">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 font-semibold">{x.label}</span>
        <span className={`num shrink-0 text-sm font-bold ${pnlClass(x.totalNet)}`}>{formatPnl(x.totalNet)}</span>
      </div>
      <p className="num text-[11px] text-muted">
        {x.trades} trades · {x.winRate ?? '–'}% win · avg {formatPnl(x.avgNet)} · halves {formatPnl(x.halves[0])} / {formatPnl(x.halves[1])}
      </p>
      {v && (
        <div className="flex items-center justify-between gap-2">
          <span className={`text-[11px] font-semibold ${v.cls}`}>{v.text}</span>
          {x.body && x.verdict === 'better' && (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onUse(x.body)}>
              Turn on
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** Shares study: every new entry rule tried on the same replayed ideas, against your settings now. "Turn on" saves it in Account > Entries > Shares. */
export function RuleTest({ t }) {
  const [busy, setBusy] = useState(false);
  if (!t) return null;
  async function use(body) {
    setBusy(true);
    try {
      await api('/auto', { method: 'PUT', body });
      toast.success('Saved. The auto trader uses it from the next idea.');
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="space-y-1 p-3">
      <div>
        <h3 className="text-sm font-semibold">Test the new entry rules</h3>
        <p className="text-[11px] leading-snug text-muted">
          {t.ideas} ideas as the live scanner would raise them over {t.days.length} days, traded with your settings now (score {t.minScore}+, your setups, stop and ladder), then with one change each. "Better" means more money and not worse in either half of the days, so one lucky day does not count.
        </p>
      </div>
      {t.warning && <p className="rounded-lg bg-surface-2 p-2 text-[11px] text-warn">{t.warning}</p>}
      <ul className="divide-y divide-line">
        <Row x={{ ...t.now, verdict: null }} />
        {t.rows.map((x) => (
          <Row key={x.key} x={x} onUse={use} busy={busy} />
        ))}
        {t.together && <Row x={t.together} onUse={use} busy={busy} />}
      </ul>
      <p className="text-[11px] leading-snug text-muted">
        <Badge>note</Badge> {t.note}
      </p>
    </Card>
  );
}
