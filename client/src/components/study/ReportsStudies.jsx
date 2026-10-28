import { useState } from 'react';
import { toast } from 'sonner';
import { useApi } from '../../lib/useApi.js';
import { api } from '../../lib/api.js';
import { FlaskConical, ListChecks } from 'lucide-react';
import { PopupTile, Segmented, Sheet, Skeleton } from '../ui.jsx';
import { DayReportButton } from '../DayReportButton.jsx';
import { OptionsStudy } from '../options/OptionsStudy.jsx';
import { OptionsEntries, Switch } from '../options/OptionsAutoCard.jsx';
import { SharesStudy } from './SharesStudy.jsx';

const STUDIES = [
  { value: 'report', label: 'Day report' },
  { value: 'options', label: 'Options' },
  { value: 'shares', label: 'Shares' },
];

/** Account > Reports and studies: copy the day's report, or replay past candles to see what pays, for options and for shares. */
export function ReportsAndStudies() {
  const [tab, setTab] = useState('report');
  const [open, setOpen] = useState(false);
  return (
    <>
      <PopupTile icon={FlaskConical} label="Studies" hint="Reports, what pays" onClick={() => setOpen(true)} />
      {open && (
        <Sheet title="Reports and studies" subtitle="Day report to paste in the chat, and the options and shares studies that show which entries pay." onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <Segmented className="w-full" size="sm" value={tab} onChange={setTab} options={STUDIES} />
            {tab === 'report' && <DayReportButton />}
            {tab === 'options' && <OptionsStudy />}
            {tab === 'shares' && <SharesStudy />}
          </div>
        </Sheet>
      )}
    </>
  );
}

/** The share setups the auto trader may trade. A switched-off setup still shows in the scanner; it is just not bought. */
function ShareSetups({ data, reload }) {
  const [busy, setBusy] = useState(false);
  if (!data) return <Skeleton className="h-24" />;
  const off = new Set(data.settings.skipSetups);

  async function toggle(setup) {
    setBusy(true);
    try {
      const next = data.setupChoices.filter((x) => (x === setup ? !off.has(x) : off.has(x)));
      await api('/auto', { method: 'PUT', body: { skipSetups: next } });
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-snug text-muted">The auto trader buys a share only when its setup is on. Level retest and VWAP pullback stay off for good, because they lost money in the track record.</p>
      <ul className="divide-y divide-line">
        {data.setupChoices.map((setup) => (
          <li key={setup} className="flex items-center justify-between gap-2 py-1.5 text-xs">
            <span>{setup}</span>
            <Switch on={!off.has(setup)} disabled={busy} label={setup} onClick={() => toggle(setup)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One line of what is switched on, shown on the closed Entries section. */
export function entrySummary(options, auto) {
  if (!options && !auto) return 'Loading what the auto traders may buy…';
  const parts = [];
  if (options) {
    const s = options.settings;
    const chosen = new Set(s.patterns);
    const labels = options.patternChoices.filter((p) => chosen.has(p.key)).map((p) => p.label.split(' (')[0]);
    parts.push(`Options: ${s.patternEntries ? (labels.length ? labels.join(', ') : 'no pattern') : 'patterns off'}, score entries ${s.scoreEntries ? 'on' : 'off'}`);
  }
  if (auto) {
    const off = new Set(auto.settings.skipSetups);
    const on = auto.setupChoices.filter((x) => !off.has(x)).length;
    parts.push(`Shares: ${on} of ${auto.setupChoices.length} setups on`);
  }
  return parts.join(' · ');
}

/** Account > Entries: what each auto trader buys on, so the findings of a study can be acted on in a tap. */
export function EntryChoices() {
  const [tab, setTab] = useState('options');
  const options = useApi('/options', []);
  const auto = useApi('/auto', []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PopupTile icon={ListChecks} label="Entries" hint="What the bots buy" onClick={() => setOpen(true)} />
      {open && (
        <Sheet title="Entries" subtitle={entrySummary(options.data, auto.data)} onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <p className="text-[11px] leading-snug text-muted">Switch on what the auto traders may buy, using what the studies show.</p>
            <Segmented className="w-full" size="sm" value={tab} onChange={setTab} options={[{ value: 'options', label: 'Options' }, { value: 'shares', label: 'Shares' }]} />
            {tab === 'options' && (options.data ? <OptionsEntries data={options.data} reload={options.reload} /> : <Skeleton className="h-24" />)}
            {tab === 'shares' && <ShareSetups data={auto.data} reload={auto.reload} />}
          </div>
        </Sheet>
      )}
    </>
  );
}
