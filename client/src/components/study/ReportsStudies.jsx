import { useState } from 'react';
import { toast } from 'sonner';
import { useApi } from '../../lib/useApi.js';
import { api } from '../../lib/api.js';
import { Card, Segmented, Skeleton } from '../ui.jsx';
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
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Reports and studies</h2>
        <p className="text-[11px] leading-snug text-muted">Copy the day report, or replay past candles to see which entries pay. Then change the entries below.</p>
      </div>
      <Segmented className="w-full" size="sm" value={tab} onChange={setTab} options={STUDIES} />
      {tab === 'report' && <DayReportButton />}
      {tab === 'options' && <OptionsStudy />}
      {tab === 'shares' && <SharesStudy />}
    </section>
  );
}

/** The share setups the auto trader may trade. A switched-off setup still shows in the scanner; it is just not bought. */
function ShareSetups() {
  const { data, reload } = useApi('/auto', []);
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

/** Account > Entries: what each auto trader buys on, so the findings of a study can be acted on in a tap. */
export function EntryChoices() {
  const [tab, setTab] = useState('options');
  const options = useApi('/options', []);
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold">Entries</h2>
        <p className="text-[11px] leading-snug text-muted">Switch on what the auto traders may buy, using what the studies show.</p>
      </div>
      <Segmented className="w-full" size="sm" value={tab} onChange={setTab} options={[{ value: 'options', label: 'Options' }, { value: 'shares', label: 'Shares' }]} />
      {tab === 'options' && (options.data ? <OptionsEntries data={options.data} reload={options.reload} /> : <Skeleton className="h-24" />)}
      {tab === 'shares' && <ShareSetups />}
    </Card>
  );
}
