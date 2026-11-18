import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useApi } from '../../lib/useApi.js';
import { api } from '../../lib/api.js';
import { Skeleton } from '../ui.jsx';
import { Switch } from '../options/OptionsAutoCard.jsx';
import { resultLine, resultTone } from '../../lib/results.js';

export const TREND_SCORE = 'Trend score';

/** Combos page > Shares > Other buy triggers: the share setups the auto trader may trade. A switched-off setup still shows in the scanner; it is just not bought. */
export function ShareSetups({ data, reload }) {
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
      <p className="text-[11px] leading-snug text-muted">The auto trader buys a share only when its setup is on. The result under each setup is from your latest Shares study ({study.data?.result ? `${study.data.result.period.days} days` : 'run one under Research'}). Level retest and VWAP pullback stay off for good, because they lost money in the track record.</p>
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
