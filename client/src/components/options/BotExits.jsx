import { useState } from 'react';
import { Bot, Calculator, Check, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { Badge, Card, Segmented } from '../ui.jsx';
import { Switch } from './OptionsAutoCard.jsx';

// Combos > one options combination: the bot-calculated stop and targets (server combos/bot.js). Calculate looks at the combination's own
// last 30 saved days, sets a stop and 3 targets on the older days and replays the newest days both ways. Nothing changes until Apply;
// the switch turns the levels on or off (off = the normal ladder); Undo puts back what was there before the last Apply.

const rs = (v) => `₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}`;
const signed = (v) => `${v < 0 ? '-' : '+'}${rs(v)}`;
const SPLITS = [
  { value: 'equal', label: 'Equal', parts: [33, 33, 34] },
  { value: 'early', label: 'More early', parts: [50, 25, 25] },
  { value: 'late', label: 'More late', parts: [25, 25, 50] },
];
const day = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/** "stop -₹900 · sell 33% at +₹700, 33% at +₹1,200, 34% at +₹1,700" */
export function levelsText(b) {
  if (!b) return '';
  return `Stop -${rs(b.stop)} · sell ${b.targets.map((t) => `${t.part}% at +${rs(t.at)}`).join(', ')}`;
}

function Row({ label, s }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 border-t border-line px-2 py-1">
      <span>{label}</span>
      <span className="w-12 text-right">{s.trades}</span>
      <span className="w-10 text-right">{s.trades ? `${Math.round((s.wins / s.trades) * 100)}%` : '—'}</span>
      <span className={`w-16 text-right font-semibold ${s.net > 0 ? 'text-up' : s.net < 0 ? 'text-down' : ''}`}>{signed(s.net)}</span>
    </div>
  );
}

function TestTable({ title, part }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold">{title}</div>
      <div className="overflow-hidden rounded-lg border border-line text-[11px]">
        <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 bg-surface-2 px-2 py-1 font-semibold text-muted">
          <span />
          <span className="w-12 text-right">Trades</span>
          <span className="w-10 text-right">Win</span>
          <span className="w-16 text-right">After charges</span>
        </div>
        <Row label="Normal ladder" s={part.normal} />
        <Row label="Bot stop + targets" s={part.bot} />
      </div>
    </div>
  );
}

function Suggestion({ s, busy, onApply }) {
  if (s.skipped) return <p className="rounded-lg bg-surface-2 p-2 text-[11px] text-muted">{s.skipped}</p>;
  const tone = s.verdict === 'better' ? 'up' : s.verdict === 'worse' ? 'down' : 'muted';
  const words = s.verdict === 'better' ? 'Better on the test days' : s.verdict === 'worse' ? 'Not better on the test days' : 'Too few test trades to judge';
  const b = s.basis;
  return (
    <div className="space-y-2 rounded-lg border border-line p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">Bot suggests</span>
        <Badge tone={tone}>{words}</Badge>
      </div>
      <p className="text-sm font-semibold">{levelsText(s)}</p>
      <p className="text-[11px] text-muted">
        From {b.trades} trades on {day(s.calcFrom)} to {day(s.calcTo)} with no profit lock: {b.reached.map((n, i) => `${n} reached +${rs(s.targets[i].at)}`).join(', ')}.
        {b.winnerDip != null ? ` 9 in 10 winners never went below -${rs(b.winnerDip)}.` : ''} Rupees are for 1 lot{s.midLots > 1 ? ` (usually ${s.midLots} lots a trade)` : ''}.
      </p>
      <TestTable title={`Test: ${day(s.hiddenFrom)} to ${day(s.hiddenTo)} (${s.hiddenDays} days the levels never saw)`} part={s.test.hidden} />
      <TestTable title={`Days used for the levels (${s.calcDays})`} part={s.test.calc} />
      <p className="text-[10px] text-muted">
        Both include charges and {s.slippagePct}% slippage each way, {s.pricing === 'real' ? 'on saved real option prices' : 'with estimated premiums where none were saved'}. This is Learn's fast replay, not the Replay test; paper-trade before trusting it. No profit is promised.
      </p>
      <button type="button" disabled={busy} onClick={onApply} className={`btn btn-sm w-full ${s.verdict === 'better' ? 'btn-primary' : 'btn-secondary'}`}>
        <Check className="h-4 w-4" /> {s.verdict === 'better' ? 'Apply and switch on' : 'Apply anyway and switch on'}
      </button>
    </div>
  );
}

/** The card on an options combination's page. `combo` is the saved one (with `bot` when levels were applied). */
export function BotExits({ combo, reload }) {
  const bot = combo.bot ?? null;
  const [busy, setBusy] = useState(false);
  const [split, setSplit] = useState('equal');
  const [sugg, setSugg] = useState(null);
  const call = async (path, body, done) => {
    setBusy(true);
    try {
      const r = await api(`/lab/learn/bot/${path}`, { method: 'POST', body: { id: combo.id, ...body } });
      done?.(r);
      if (path !== 'suggest') reload();
    } catch (e) {
      toast.error(e.message || 'Could not do that');
    } finally {
      setBusy(false);
    }
  };
  const calculate = (value = split) => call('suggest', { parts: SPLITS.find((x) => x.value === value).parts }, setSugg);
  const apply = () =>
    call('apply', { stop: sugg.stop, targets: sugg.targets, info: { verdict: sugg.verdict, hidden: sugg.test.hidden, from: sugg.calcFrom, to: sugg.hiddenTo } }, () => {
      setSugg(null);
      toast.success('Bot stop and targets on for this combination');
    });
  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <Bot className="h-4 w-4 text-accent2" /> Bot stop and targets
            {bot?.setAt && <Badge tone="accent">Set by bot</Badge>}
          </div>
          <p className="text-[11px] text-muted">{bot?.on ? 'On: this combination sells in parts at the targets below.' : 'Off: this combination uses the normal ladder.'}</p>
        </div>
        <Switch on={Boolean(bot?.on)} disabled={busy || !bot} label="Use the bot stop and targets" onClick={() => call('switch', { on: !bot?.on })} />
      </div>
      {bot && (
        <div className={`rounded-lg p-2 text-[11px] ${bot.on ? 'bg-up-soft' : 'bg-surface-2 text-muted'}`}>
          <p className="text-xs font-semibold">{levelsText(bot)} (per lot)</p>
          {bot.setAt && <p>Set by bot on {when(bot.setAt)}{bot.info?.hidden ? `; on its test days ${signed(bot.info.hidden.bot.net)} against ${signed(bot.info.hidden.normal.net)} with the normal ladder` : ''}.</p>}
        </div>
      )}
      <p className="text-[10px] text-muted">After target 1 the stop moves to the entry (plus charges), after target 2 to target 1; target 3 sells the rest. 3 lots sell one at each target; 2 lots sell at targets 1 and 3; 1 lot sells at target 2.</p>
      <div className="space-y-1">
        <div className="text-[11px] text-muted">How much to sell at each target</div>
        <Segmented
          className="w-full"
          size="sm"
          cols={3}
          value={split}
          options={SPLITS.map(({ value, label }) => ({ value, label }))}
          onChange={(v) => {
            setSplit(v);
            if (sugg) calculate(v);
          }}
        />
      </div>
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => calculate()} className="btn btn-secondary btn-sm flex-1">
          <Calculator className="h-4 w-4" /> {busy && !sugg ? 'Calculating…' : 'Calculate from last 30 days'}
        </button>
        {bot && bot.prev !== undefined && (
          <button type="button" disabled={busy} onClick={() => call('undo', {})} className="btn btn-secondary btn-sm">
            <Undo2 className="h-4 w-4" /> Undo
          </button>
        )}
      </div>
      {sugg && <Suggestion s={sugg} busy={busy} onApply={apply} />}
    </Card>
  );
}
