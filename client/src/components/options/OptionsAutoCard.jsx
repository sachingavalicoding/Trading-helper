import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { Bot } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { formatPrice, pnlClass } from '../../lib/format.js';
import { Badge, Card, Segmented } from '../ui.jsx';
import { resultLine, resultTone } from '../../lib/results.js';
import { STOP_ATRS, STOP_MODES, STOP_POINTS } from '../../lib/stops.js';

const FIELDS = [
  { key: 'budget', label: 'Money for options (₹)', step: 1000, min: 5000, max: 100000000 },
  { key: 'maxLots', label: 'Most lots in one trade', step: 1, min: 1, max: 20 },
  { key: 'maxOpen', label: 'Most trades open at once', step: 1, min: 1, max: 3 },
  { key: 'maxTrades', label: 'Most trades a day', step: 1, min: 1, max: 10 },
  { key: 'dailyLossPct', label: 'Stop for the day after losing (%)', step: 1, min: 2, max: 30 },
  { key: 'lossStreak', label: 'Stop for the day after this many losses in a row (0 = off)', step: 1, min: 0, max: 5 },
  { key: 'benchAfter', label: 'Switch a combination off after this many live losses in a row (0 = off)', step: 1, min: 0, max: 10 },
];

const STUDY_WINNERS = ['breakout', 'engulfing']; // 30-day study: over 20 trades each and a win rate above the roughly 61% break-even (inside bar and EMA cross made money on only 6 and 7 trades)

export function Switch({ on, onClick, disabled, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onClick} className={`relative h-6 w-10 shrink-0 rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-accent' : 'bg-surface-3'}`}>
      <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  );
}

/** What the trader buys on: the indexes, chart patterns picked from the study, and your own combinations. Lives in the Account tab. */
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
  const study = useApi('/study/options', []);
  const stats = useMemo(() => new Map((study.data?.result?.techniques ?? []).map((t) => [t.key, t])), [study.data]);
  const mine = (s.combos || []).filter((c) => c.on).length;
  const triggers = [s.patternEntries && s.patterns.length > 0 && 'patterns', s.comboEntries && mine > 0 && 'combinations'].filter(Boolean);
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <h4 className="text-xs font-semibold">What triggers a buy</h4>
        <p className="text-[11px] leading-snug text-muted">Switch on what you trust. The result beside each pattern is from your latest Options study ({study.data?.result ? `${study.data.result.period.days} days` : 'run one under Studies'}), so you can see which ones pay before you switch them on.</p>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-snug text-muted">
            <b className="text-fg">Chart patterns.</b> Buys when a pattern completes on a closed 5-minute bar.
          </p>
          <Switch on={s.patternEntries} disabled={busy} label="Chart patterns" onClick={() => save({ patternEntries: !s.patternEntries })} />
        </div>
        {s.patternEntries && (
          <ul className="divide-y divide-line">
            {data.patternChoices.map((p) => {
              const r = stats.get(p.key);
              return (
                <li key={p.key} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                  <span className="min-w-0">
                    {p.label} {STUDY_WINNERS.includes(p.key) && <Badge tone="up">Study winner</Badge>}
                    {r && <span className={`num block text-[11px] ${resultTone(r)}`}>{resultLine(r)}</span>}
                  </span>
                  <Switch on={chosen.has(p.key)} disabled={busy} label={p.label} onClick={() => toggle(p.key)} />
                </li>
              );
            })}
          </ul>
        )}
        {s.patternEntries && (
          <div className="space-y-1">
            <p className="text-[11px] leading-snug text-muted">
              <b className="text-fg">Pattern score.</b> Buy a pattern only when the chart's score for that side (the one on the Signal tab) is at least this. The study row "Patterns, score 70+ agrees" shows what that would have paid.
            </p>
            <Segmented className="w-full" size="sm" value={s.patternMinScore ?? 0} onChange={(v) => save({ patternMinScore: v })} options={[{ value: 0, label: 'Off' }, { value: 60, label: '60+' }, { value: 70, label: '70+' }, { value: 80, label: '80+' }]} />
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-snug text-muted">
            <b className="text-fg">My combinations.</b> Buys when one of the combinations you built turns true ({mine ? `${mine} switched on` : 'none built yet, make one under My combinations'}).
          </p>
          <Switch on={s.comboEntries} disabled={busy} label="My combinations" onClick={() => save({ comboEntries: !s.comboEntries })} />
        </div>
        {s.comboEntries && (
          <div className="space-y-1">
            <p className="text-[11px] leading-snug text-muted">
              <b className="text-fg">Combination score.</b> Buy a combination only when the chart's score for that side is at least this. Off means the score is only shown, never used to skip.
            </p>
            <Segmented className="w-full" size="sm" value={s.comboMinScore ?? 0} onChange={(v) => save({ comboMinScore: v })} options={[{ value: 0, label: 'Off' }, { value: 50, label: '50+' }, { value: 60, label: '60+' }, { value: 70, label: '70+' }]} />
          </div>
        )}
        <p className={`text-[11px] leading-snug ${triggers.length ? 'text-muted' : 'text-warn'}`}>{triggers.length ? `Buying on: ${triggers.join(', ')}.` : 'Nothing will be bought: switch on at least one trigger.'}</p>
      </div>

      <SpeedSettings data={data} reload={reload} />
      <p className="text-[11px] leading-snug text-muted">Where the stop goes, the trailing stop and the profit lock are in Account &gt; Limits.</p>
    </div>
  );
}

/** Account > Entries: how fast the bot buys (5 min / 1 min / 1 sec) and sells the chart stop. */
export function SpeedSettings({ data, reload }) {
  async function save(patch) {
    try {
      await api('/options', { method: 'PUT', body: patch });
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    }
  }
  const s = data.settings;
  return (
    <div className="space-y-2 rounded-lg bg-surface-2 p-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">How fast to buy and sell</p>
      <div className="space-y-1">
        <p className="text-[11px] leading-snug text-muted">
          <b className="text-fg">Buy when.</b> 5 min: the 5-minute candle has closed with your pattern (the tested way). 1 min: your combination is read at each minute mark on the forming candle. 1 sec: it buys the second the combination turns true{s.entryClock === '1s' ? `, once it has stayed true for ${s.secondConfirm ?? 3} seconds` : ''}. Faster means earlier prices but more false signals, because a forming candle can still change.
        </p>
        <Segmented size="sm" className="w-full" value={s.entryClock ?? '5m'} onChange={(v) => save({ entryClock: v })} options={[{ value: '5m', label: '5 min' }, { value: '1m', label: '1 min' }, { value: '1s', label: '1 sec' }]} />
        {s.entryClock === '1s' && (
          <Segmented size="sm" className="w-full" value={String(s.secondConfirm ?? 3)} onChange={(v) => save({ secondConfirm: Number(v) })} options={[{ value: '0', label: 'At once' }, { value: '3', label: 'Held 3 s' }, { value: '8', label: 'Held 8 s' }]} />
        )}
      </div>
      <div className="space-y-1">
        <p className="text-[11px] leading-snug text-muted">
          <b className="text-fg">Sell the chart stop when.</b> 5 min or 1 min: a candle of that size closes beyond the stop. 1 sec: the moment the index touches it, which limits the loss but also sells on a wick. Profit lock and the premium stop always work on every price.
        </p>
        <Segmented size="sm" className="w-full" value={s.exitClock ?? '1m'} onChange={(v) => save({ exitClock: v })} options={[{ value: '5m', label: '5 min' }, { value: '1m', label: '1 min' }, { value: '1s', label: '1 sec' }]} />
      </div>
      <p className="text-[11px] leading-snug text-muted">The study and Lab still replay closed candles; only 3 days of seconds are recorded, so the fast settings cannot be proven yet. Try them on paper and compare.</p>
    </div>
  );
}

/** Account > Limits > Options: where the first stop goes for every entry (pattern or combination): the chart level, capped, ATR or fixed points. */
export function StopPlacement({ data, reload }) {
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
  const mode = STOP_MODES.find((m) => m.value === s.patternStopMode) ?? STOP_MODES[0];
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <h4 className="text-sm font-semibold">Options: where the stop goes</h4>
        <p className="text-[11px] leading-snug text-muted">Used for every entry (pattern or combination), in the study and in Review. {mode.hint}</p>
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
            <span>Index points from the entry</span>
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
        Buys one Nifty at-the-money call or put when a chart pattern or one of your combinations turns true. The stop and the profit lock are the ones in your Account tab, and everything the auto trader bought is closed at the exit time in your Account tab (15:15 unless you changed it).
      </p>
      <p className="text-[11px] leading-snug text-muted">
        Buys on: {s.patternEntries ? `${s.patterns.length} chart patterns` : 'no chart patterns'}, {s.comboEntries ? 'your combinations' : 'no combinations'}. Change this in Account &gt; Entries.
      </p>
      {s.enabled && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 p-2">
          <p className="text-[11px] leading-snug text-muted">
            <b className="text-fg">Pause new buys for today.</b> {s.pausedToday ? 'Paused: no new automatic buy until tomorrow. Open trades keep their stops and exits.' : 'Use it when the market has already made its move and you do not want the bot chasing it. It switches itself back on tomorrow.'}
          </p>
          <Switch on={Boolean(s.pausedToday)} disabled={busy} label="Pause new buys for today" onClick={() => save({ pauseToday: !s.pausedToday })} />
        </div>
      )}
      <div className="space-y-2 rounded-lg bg-surface-2 p-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Safety rules (the study, finder and Lab replay them too)</p>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-snug text-muted">
            <b className="text-fg">With the day only.</b> Calls only while the index is above both today's open and today's average, puts only below both. On 4 Nov the ₹3,955 loss was a put bought on an up day.
          </p>
          <Switch on={Boolean(s.withDay)} disabled={busy} label="With the day only" onClick={() => save({ withDay: !s.withDay })} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-snug text-muted">
            <b className="text-fg">New combinations start at 1 lot.</b> A combination is bought with 1 lot until it has 10 closed live trades. A study of 10 days is a handful of trades; live is the real test.
          </p>
          <Switch on={s.probation !== false} disabled={busy} label="New combinations start at 1 lot" onClick={() => save({ probation: s.probation === false })} />
        </div>
        <div className="space-y-1">
          <p className="text-[11px] leading-snug text-muted">
            <b className="text-fg">Rest a losing entry.</b> After this many losses in a row today from the same pattern or combination, it stops until tomorrow. The others keep trading.
          </p>
          <Segmented size="sm" className="w-full" value={String(s.comboStreak ?? 0)} onChange={(v) => save({ comboStreak: Number(v) })} options={[{ value: '0', label: 'Off' }, { value: '2', label: '2 in a row' }, { value: '3', label: '3 in a row' }]} />
        </div>
      </div>
      <p className="text-[11px] leading-snug text-muted">
        {s.movedText ? `${s.movedText}. ` : 'No limit on how far the market already moved. '}
        {s.chasePct > 0 ? `Skips a buy when the premium is over ${s.chasePct}% above its ${s.chaseMinutes ?? 15}-minute low. ` : ''}
        Each skip and its reason is in the Options log.{' '}
        <Link to="/research?tab=moved" className="font-semibold text-accent">Test the already-moved check</Link> ·{' '}
        <Link to="/research?tab=ladder" className="font-semibold text-accent">Test profit ladders</Link>
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
