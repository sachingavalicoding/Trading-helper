import { useState } from 'react';
import { Bot } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { formatPrice, pnlClass } from '../../lib/format.js';
import { Badge, Card } from '../ui.jsx';

const FIELDS = [
  { key: 'budget', label: 'Money set aside for options (₹)', step: 1000, min: 5000, max: 100000000 },
  { key: 'maxLots', label: 'Most lots in one trade', step: 1, min: 1, max: 20 },
  { key: 'maxTrades', label: 'Most trades a day', step: 1, min: 1, max: 10 },
  { key: 'dailyLossPct', label: 'Stop for the day after losing (%)', step: 1, min: 2, max: 30 },
  { key: 'minScore', label: 'Minimum score', step: 5, min: 60, max: 100 },
];

const STUDY_WINNERS = ['breakout', 'insideBar', 'emaCross']; // positive over 30 days on more than 12 trades in the Study tab

export function Switch({ on, onClick, disabled, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick} className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-accent' : 'bg-surface-3'}`}>
      <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );
}

/** What the trader buys on: chart patterns picked from the study, and the original all-checks score. Lives in the Account tab. */
export function OptionsEntries({ data, reload }) {
  const [busy, setBusy] = useState(false);
  async function save(patch) {
    setBusy(true);
    try {
      await api('/options', { method: 'PUT', body: patch });
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }
  const s = data.settings;
  const chosen = new Set(s.patterns);
  const toggle = (key) => save({ patterns: data.patternChoices.map((p) => p.key).filter((k) => (k === key ? !chosen.has(k) : chosen.has(k))) });
  return (
    <div className="space-y-2">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-snug text-muted">
            <b className="text-fg">Chart patterns.</b> Buys when a pattern completes on a closed 5-minute bar, with the pattern's own chart stop.
          </p>
          <Switch on={s.patternEntries} disabled={busy} label="Chart patterns" onClick={() => save({ patternEntries: !s.patternEntries })} />
        </div>
        {s.patternEntries && (
          <ul className="divide-y divide-line">
            {data.patternChoices.map((p) => (
              <li key={p.key} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                <span className="min-w-0">
                  {p.label} {STUDY_WINNERS.includes(p.key) && <Badge tone="up">Study winner</Badge>}
                </span>
                <Switch on={chosen.has(p.key)} disabled={busy} label={p.label} onClick={() => toggle(p.key)} />
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-snug text-muted">
            <b className="text-fg">Score entries.</b> The original rule: every chart check agrees and the score reaches the minimum.
          </p>
          <Switch on={s.scoreEntries} disabled={busy} label="Score entries" onClick={() => save({ scoreEntries: !s.scoreEntries })} />
        </div>
      </div>
    </div>
  );
}

/** Switch for the paper options trader and its limits. Paper money only. */
export function OptionsAutoCard({ data, reload }) {
  const [busy, setBusy] = useState(false);
  const s = data.settings;

  async function save(patch) {
    setBusy(true);
    try {
      await api('/options', { method: 'PUT', body: patch });
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold">
            <Bot className="h-4 w-4 text-accent" /> Auto paper options
            <Badge tone={s.enabled ? 'up' : 'muted'}>{s.enabled ? 'On' : 'Off'}</Badge>
          </h2>
          <p className="num text-xs text-muted">
            Today: {data.today.trades} trades · {data.today.open} open · <span className={pnlClass(data.today.pnl)}>₹{formatPrice(data.today.pnl)}</span>
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={s.enabled}
          aria-label="Auto paper options"
          disabled={busy}
          onClick={() => save({ enabled: !s.enabled })}
          className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${s.enabled ? 'bg-accent' : 'bg-surface-3'}`}
        >
          <span className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white transition-transform ${s.enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>
      <p className="text-[11px] leading-snug text-muted">
        Buys one Nifty at-the-money call or put when the chart is clear. The stop and the profit lock are the ones in your Account tab, and everything the auto trader bought is closed at the 15:15 square-off.
      </p>
      <p className="text-[11px] leading-snug text-muted">
        Buys on: {s.patternEntries ? `${s.patterns.length} chart patterns` : 'no chart patterns'}, score entries {s.scoreEntries ? 'on' : 'off'}. Change this in Account &gt; Entries.
      </p>
      <p className="text-[11px] leading-snug text-muted">{data.disclaimer}</p>
    </Card>
  );
}

/** The limits of the options auto-trader. They live in the Account tab, next to the stop and profit lock. */
export function OptionsLimits({ data, reload }) {
  const s = data.settings;

  async function save(patch) {
    try {
      await api('/options', { method: 'PUT', body: patch });
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    }
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {FIELDS.map((f) => (
        <label key={f.key} className="text-[11px] text-muted">
          {f.label}
          <input
            type="number"
            inputMode="decimal"
            defaultValue={s[f.key]}
            step={f.step}
            min={f.min}
            max={f.max}
            onBlur={(e) => e.target.value !== '' && Number(e.target.value) !== s[f.key] && save({ [f.key]: Number(e.target.value) })}
            className="num mt-0.5 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent"
          />
        </label>
      ))}
    </div>
  );
}
