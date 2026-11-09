import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useApi } from '../../lib/useApi.js';
import { api } from '../../lib/api.js';
import { FlaskConical, ListChecks } from 'lucide-react';
import { PopupTile, Segmented, Sheet, Skeleton } from '../ui.jsx';
import { DayReportButton } from '../DayReportButton.jsx';
import { OptionsStudy } from '../options/OptionsStudy.jsx';
import { OptionsEntries, Switch } from '../options/OptionsAutoCard.jsx';
import { SharesStudy } from './SharesStudy.jsx';
import { FinderStudy } from './FinderStudy.jsx';
import { HistoryData } from './HistoryData.jsx';
import { resultLine, resultTone } from '../../lib/results.js';
import { ComboBuilder } from './ComboBuilder.jsx';

const STUDIES = [
  { value: 'report', label: 'Report' },
  { value: 'options', label: 'Options' },
  { value: 'shares', label: 'Shares' },
  { value: 'finder', label: 'Finder' },
  { value: 'data', label: 'Data' },
];

/** Account > Reports and studies: copy the day's report, or replay past candles to see what pays, for options and for shares. */
export function ReportsAndStudies() {
  const [tab, setTab] = useState('report');
  const [open, setOpen] = useState(false);
  return (
    <>
      <PopupTile icon={FlaskConical} label="Studies" hint="Reports, what pays" onClick={() => setOpen(true)} />
      {open && (
        <Sheet title="Reports and studies" subtitle="Day report to paste in the chat, the options and shares studies that show which entries pay, and the saved candles they read." onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <Segmented className="w-full" size="sm" value={tab} onChange={setTab} options={STUDIES} />
            {tab === 'report' && <DayReportButton />}
            {tab === 'options' && <OptionsStudy />}
            {tab === 'shares' && <SharesStudy />}
            {tab === 'finder' && <FinderStudy />}
            {tab === 'data' && <HistoryData />}
          </div>
        </Sheet>
      )}
    </>
  );
}

const TREND_SCORE = 'Trend score';

/** The share setups the auto trader may trade. A switched-off setup still shows in the scanner; it is just not bought. */
function ShareSetups({ data, reload }) {
  const [busy, setBusy] = useState(false);
  const study = useApi('/study/shares', []);
  const stats = useMemo(() => new Map((study.data?.result?.bySetup ?? []).map((r) => [r.key, r])), [study.data]);
  if (!data) return <Skeleton className="h-24" />;
  const off = new Set(data.settings.skipSetups);

  // Trend score (the score-led entry) has its own switch, off until you turn it on; the others are on unless skipped
  const isOn = (setup) => (setup === TREND_SCORE ? Boolean(data.settings.trendScore) && !off.has(setup) : !off.has(setup));
  async function toggle(setup) {
    setBusy(true);
    try {
      if (setup === TREND_SCORE) {
        await api('/auto', { method: 'PUT', body: { trendScore: !isOn(setup), skipSetups: data.setupChoices.filter((x) => x !== setup && off.has(x)) } });
        reload();
        return;
      }
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
      <p className="text-[11px] leading-snug text-muted">The auto trader buys a share only when its setup is on. The result under each setup is from your latest Shares study ({study.data?.result ? `${study.data.result.period.days} days` : 'run one under Studies'}). Level retest and VWAP pullback stay off for good, because they lost money in the track record.</p>
      <ul className="divide-y divide-line">
        {data.setupChoices.map((setup) => (
          <li key={setup} className="flex items-center justify-between gap-2 py-1.5 text-xs">
            <span className="min-w-0">
              {setup}
              {setup === TREND_SCORE && <span className="block text-[11px] leading-snug text-muted">No pattern of its own: a stock trending on 5 and 15 minutes, past VWAP, that just pushed on. The score of all indicators decides (your minimum score). New: check it in the Shares study first.</span>}
              {stats.get(setup) && <span className={`num block text-[11px] ${resultTone(stats.get(setup))}`}>{resultLine(stats.get(setup))}</span>}
            </span>
            <Switch on={isOn(setup)} disabled={busy} label={setup} onClick={() => toggle(setup)} />
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
    const mine = (s.combos || []).filter((c) => c.on).length;
    parts.push(`Options (Nifty): ${s.scoreEntries ? `score ${s.minScore}+, ` : ''}${s.patternEntries ? (labels.length ? labels.join(', ') : 'no pattern') : 'patterns off'}${mine ? `, ${s.comboEntries === false ? 'combinations off' : `${mine} of your combinations`}` : ''}`);
  }
  if (auto) {
    const off = new Set(auto.settings.skipSetups);
    const on = auto.setupChoices.filter((x) => !off.has(x) && (x !== TREND_SCORE || auto.settings.trendScore)).length;
    const mine = (auto.settings.combos || []).filter((c) => c.on).length;
    parts.push(`Shares: ${on} of ${auto.setupChoices.length} setups on${mine ? `, ${mine} of your combinations` : ''}`);
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
            {tab === 'options' &&
              (options.data ? (
                <>
                  <OptionsEntries data={options.data} reload={options.reload} />
                  <hr className="border-line" />
                  <ComboBuilder kind="options" endpoint="/options" combos={options.data.settings.combos} reload={options.reload} />
                </>
              ) : (
                <Skeleton className="h-24" />
              ))}
            {tab === 'shares' && (
              <>
                <ShareSetups data={auto.data} reload={auto.reload} />
                {auto.data && (
                  <>
                    <hr className="border-line" />
                    <ComboBuilder kind="shares" endpoint="/auto" combos={auto.data.settings.combos} reload={auto.reload} />
                  </>
                )}
              </>
            )}
          </div>
        </Sheet>
      )}
    </>
  );
}
