import { useState } from 'react';
import { Bot } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { formatPrice, pnlClass } from '../../lib/format.js';
import { Badge, Card, Segmented } from '../ui.jsx';
import { STOP_ATRS, STOP_MODES, STOP_POINTS } from '../../lib/stops.js';

const FIELDS = [
  { key: 'budget', label: 'Money set aside for options (₹)', step: 1000, min: 5000, max: 100000000 },
  { key: 'maxLots', label: 'Most lots in one trade', step: 1, min: 1, max: 20 },
  { key: 'maxTrades', label: 'Most trades a day', step: 1, min: 1, max: 10 },
  { key: 'dailyLossPct', label: 'Stop for the day after losing (%)', step: 1, min: 2, max: 30 },
  { key: 'minScore', label: 'Minimum score', step: 5, min: 60, max: 100 },
];

const STUDY_WINNERS = ['breakout', 'engulfing']; // 30-day study: over 20 trades each and a win rate above the roughly 61% break-even (inside bar and EMA cross made money on only 6 and 7 trades)

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
  const mine = (s.combos || []).filter((c) => c.on).length;
  const triggers = [s.scoreEntries && 'score', s.patternEntries && s.patterns.length > 0 && 'patterns', s.comboEntries && mine > 0 && 'combinations'].filter(Boolean);
  const mode = STOP_MODES.find((m) => m.value === s.patternStopMode) ?? STOP_MODES[0];
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <h4 className="text-xs font-semibold">What triggers a buy</h4>
        <p className="text-[11px] leading-snug text-muted">Switch on any mix. Each one on its own works too: only score, only patterns, only your combinations, or all three.</p>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-snug text-muted">
            <b className="text-fg">Score.</b> The original rule: every chart check agrees and the score reaches the minimum.
          </p>
          <Switch on={s.scoreEntries} disabled={busy} label="Score entries" onClick={() => save({ scoreEntries: !s.scoreEntries })} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-snug text-muted">
            <b className="text-fg">Chart patterns.</b> Buys when a pattern completes on a closed 5-minute bar. Pick the patterns below.
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
            <b className="text-fg">My combinations.</b> Buys when one of the combinations you built turns true ({mine ? `${mine} switched on` : 'none built yet, make one under My combinations'}).
          </p>
          <Switch on={s.comboEntries} disabled={busy} label="My combinations" onClick={() => save({ comboEntries: !s.comboEntries })} />
        </div>
        <p className={`text-[11px] leading-snug ${triggers.length ? 'text-muted' : 'text-warn'}`}>{triggers.length ? `Buying on: ${triggers.join(', ')}. Patterns and combinations are checked first, then the score.` : 'Nothing will be bought: switch on at least one trigger.'}</p>
      </div>

      <div className="space-y-1.5">
        <h4 className="text-xs font-semibold">Where the stop goes</h4>
        <p className="text-[11px] leading-snug text-muted">Used for every trigger above, in the study and in Review. {mode.hint}</p>
        <Segmented className="w-full" size="sm" value={s.patternStopMode} onChange={(v) => save({ patternStopMode: v })} options={STOP_MODES.map((m) => ({ value: m.value, label: m.label }))} />
        {(s.patternStopMode === 'cap' || s.patternStopMode === 'atr') && (
          <label className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>{s.patternStopMode === 'cap' ? 'Never further than' : 'Always'} (ATRs from the entry)</span>
            <select className="field num !w-24 !px-2 !py-1.5 !text-sm" value={s.patternStopAtr} disabled={busy} onChange={(e) => save({ patternStopAtr: Number(e.target.value) })} aria-label="Stop distance in ATRs">
              {STOP_ATRS.map((k) => (
                <option key={k} value={k}>
                  {k} ATR
                </option>
              ))}
            </select>
          </label>
        )}
        {s.patternStopMode === 'fixed' && (
          <label className="flex items-center justify-between gap-3 text-xs text-muted">
            <span>Nifty points from the entry</span>
            <select className="field num !w-24 !px-2 !py-1.5 !text-sm" value={s.patternStopPoints} disabled={busy} onChange={(e) => save({ patternStopPoints: Number(e.target.value) })} aria-label="Stop distance in points">
              {(STOP_POINTS.includes(s.patternStopPoints) ? STOP_POINTS : [...STOP_POINTS, s.patternStopPoints].sort((x, y) => x - y)).map((p) => (
                <option key={p} value={p}>
                  {p} pts
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="text-[11px] leading-snug text-muted">A stop over 2.5 ATR from the entry, or one that risks more than your loss limit for one lot, is still skipped. The study rows "Breakout + Engulfing, stop …" show what each choice would have earned. The profit lock after entry is the same for all.</p>
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
        Buys one Nifty at-the-money call or put when the chart is clear. The stop and the profit lock are the ones in your Account tab, and everything the auto trader bought is closed at the exit time in your Account tab (15:15 unless you changed it).
      </p>
      <p className="text-[11px] leading-snug text-muted">
        Buys on: {s.patternEntries ? `${s.patterns.length} chart patterns` : 'no chart patterns'}, {s.comboEntries ? 'your combinations' : 'no combinations'}, score entries {s.scoreEntries ? 'on' : 'off'}. Change this in Account &gt; Entries.
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
