import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { Switch } from '../options/OptionsAutoCard.jsx';

// Account > Entries > Shares: the extra entry rules of the share auto trader (server/src/scanner/entryRules.js).
const SWITCHES = [
  { key: 'marketAgree', label: 'Nifty must agree', hint: 'Buy only when Nifty 50 is trending up, sell only when it trends down. No share trade while Nifty moves sideways.' },
  { key: 'confirmBar', label: 'Wait for a 5-minute close', hint: 'Do not buy on the bar that breaks out. Wait up to 10 minutes for a 5-minute bar to close past the entry, then buy. A spike that falls straight back is skipped.' },
];
const NUMBERS = [
  { key: 'minVsNifty', label: 'Stronger than Nifty by at least (%)', hint: '0 = off. For a buy the share must be up this much more than Nifty today.', step: '0.1' },
  { key: 'minRelVol', label: 'Volume at least (x normal)', hint: '0 = off. Volume of the last 15 minutes against normal for that time of day.', step: '0.1' },
  { key: 'noChaseR', label: 'Do not chase past (R)', hint: 'Skip when the price already ran this many risks past the entry. 0.5 was the old fixed value.', step: '0.1' },
  { key: 'minStopPct', label: 'Smallest stop (% of price)', hint: 'Skip ideas with a closer stop. 0.5 was the old fixed value; 0 = off.', step: '0.1' },
  { key: 'stopAfterLosses', label: 'No new trade after this many losses a day', hint: '0 = off.', step: '1' },
  { key: 'target', label: 'Sell at a fixed profit (₹)', hint: '0 = use your profit ladder. For example 250 sells once the trade is up ₹250.', step: '50' },
];

export function ShareEntryRules({ data, reload }) {
  const rules = data.settings.shareRules ?? {};
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft({}), [data]);
  async function save(patch) {
    setBusy(true);
    try {
      await api('/auto', { method: 'PUT', body: { shareRules: patch } });
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }
  const value = (k) => draft[k] ?? String(rules[k] ?? 0);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Entry rules for shares</h3>
      <p className="text-[11px] leading-snug text-muted">Extra checks before the auto trader buys a share. Check each one first in Studies &gt; Shares &gt; "Test the new entry rules", which can turn on the ones that won.</p>
      <ul className="divide-y divide-line">
        {SWITCHES.map((s) => (
          <li key={s.key} className="flex items-center justify-between gap-2 py-1.5 text-xs">
            <span className="min-w-0">
              {s.label}
              <span className="block text-[11px] leading-snug text-muted">{s.hint}</span>
            </span>
            <Switch on={Boolean(rules[s.key])} disabled={busy} label={s.label} onClick={() => save({ [s.key]: !rules[s.key] })} />
          </li>
        ))}
        {NUMBERS.map((n) => (
          <li key={n.key} className="flex items-center justify-between gap-2 py-1.5 text-xs">
            <span className="min-w-0">
              {n.label}
              <span className="block text-[11px] leading-snug text-muted">{n.hint}</span>
            </span>
            <input
              className="field num !w-20 !px-2 !py-1.5 text-right !text-sm"
              inputMode="decimal"
              step={n.step}
              aria-label={n.label}
              value={value(n.key)}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, [n.key]: e.target.value })}
              onBlur={() => {
                if (draft[n.key] == null) return;
                const v = Number(draft[n.key]);
                if (!Number.isFinite(v) || v < 0) return toast.error('Enter a number, 0 or more');
                if (v !== rules[n.key]) save({ [n.key]: v });
              }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
