import { useEffect, useState } from 'react';
import { Database, Download, LineChart } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { failedText, jobPercent, liveText, savedText, SYNC_LABEL } from '../../lib/history.js';
import { Badge, Card, Skeleton } from '../ui.jsx';
import { YearFiles, OptionMail } from './YearData.jsx';

const JOB_TONE = { running: 'accent', done: 'up', partial: 'warn', failed: 'down' };
const JOB_WORD = { running: 'Downloading', done: 'Finished', partial: 'Finished, some failed', failed: 'Failed' };


/** Research > Data: the real option premiums saved each evening, which Review, the studies and the Finder read when "real prices" is on. */
function OptionPrices() {
  const { data, error, reload } = useApi('/option-history');
  const [busy, setBusy] = useState(false);
  const job = data?.job;
  const running = job?.state === 'running';

  useEffect(() => {
    if (!running) return undefined;
    const t = setTimeout(reload, 3000);
    return () => clearTimeout(t);
  }, [running, data, reload]);

  async function call(path, ok) {
    setBusy(true);
    try {
      await api(`/option-history/${path}`, { method: 'POST', body: {} });
      toast.success(ok);
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not start');
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return null;
  if (!data) return <Skeleton className="h-32" />;
  const s = data.saved || {};
  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <LineChart size={16} className="text-accent" aria-hidden />
        <h3 className="text-sm font-semibold">Option prices (real)</h3>
        {job && job.state !== 'idle' && <Badge tone={JOB_TONE[job.state] || 'muted'}>{JOB_WORD[job.state] || job.state}</Badge>}
      </div>
      <p className="num text-xs">
        {s.days ? `${s.days} day${s.days > 1 ? 's' : ''} saved, ${s.from} to ${s.to} (${s.contracts} contracts${s.backfilledDays ? `, ${s.backfilledDays} read back` : ''}). Keeps the last ${s.keeps}.` : 'No days saved yet.'}
      </p>
      <p className="text-[11px] leading-snug text-muted">Review, the studies and the Finder use these real premiums when they have them for a day. A day with none shows "estimated by the model". Premiums are saved automatically after 15:40 on a weekday, only while the app is running and logged in to Upstox. If you missed a day, the buttons below fetch what Upstox still has.</p>
      {data.simulated && <p className="text-[11px] text-warn">The sample feed has no real option prices. Log in to Upstox first.</p>}
      {running && <p className="num text-[11px] text-muted">{job.done} of {job.total} contracts{job.step ? `, now ${job.step}` : ''}</p>}
      {job?.error && <p className="text-[11px] text-down">{job.error}</p>}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn" disabled={busy || running || data.simulated} onClick={() => call('sync', 'Saving today\'s prices')}>
          Save today now
        </button>
        <button type="button" className="btn" disabled={busy || running || data.simulated} onClick={() => call('backfill', 'Reading back the missing days')}>
          Read back missing days
        </button>
      </div>
      <p className="text-[11px] leading-snug text-muted">"Save today now" works on a trading day after the market closes. "Read back" covers the past days for contracts Upstox still lists; expired contracts are gone, so those days can be partial.</p>
    </Card>
  );
}

/** Research > Data: the three months of 1-minute candles saved in the database, which the studies and Review read. */
export function HistoryData() {
  const { data, error, reload } = useApi('/history');
  const [starting, setStarting] = useState(false);
  const job = data?.job;
  const running = job?.state === 'running';

  useEffect(() => {
    if (!running) return undefined;
    const t = setTimeout(reload, 3000);
    return () => clearTimeout(t);
  }, [running, data, reload]);

  async function start() {
    setStarting(true);
    try {
      await api('/history/sync', { method: 'POST', body: {} });
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not start the download');
    } finally {
      setStarting(false);
    }
  }

  if (error && !data) return <p className="text-xs text-down">{error.message || 'Could not load the saved data'}</p>;
  if (!data) return <Skeleton className="h-32" />;

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-snug text-muted">{data.note}</p>
      <Card className="space-y-2 p-3">
        <div className="flex items-center gap-2">
          <Database size={16} className="text-accent" aria-hidden />
          <h3 className="text-sm font-semibold">Saved candles</h3>
        </div>
        <p className="num text-xs">{savedText(data.saved)}</p>
        {!data.simulated && data.saved?.days > 0 && <p className="text-[11px] text-muted">{liveText(data.liveAt)}</p>}
        {data.simulated && <p className="text-[11px] text-warn">The sample feed has no real history. Log in to Upstox, then download.</p>}
        <button type="button" onClick={start} disabled={starting || running || data.simulated} className="btn btn-primary w-full">
          <Download size={16} aria-hidden />
          {running ? 'Downloading…' : SYNC_LABEL}
        </button>
        <p className="text-[11px] leading-snug text-muted">The first press asks Upstox for about 3 months of candles, paced to stay under its limit, so it takes a few minutes. After that it only fetches the days that are missing and today so far (so a study can include today), and removes the oldest days beyond 3 months. Days already saved are never fetched again, except today, which is read again on each press. After 15:40 each weekday the day is completed on its own.</p>
      </Card>

      <OptionPrices />

      <YearFiles />
      <OptionMail />

      {job && job.state !== 'idle' && (
        <Card className="space-y-2 p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Last download</h3>
            <Badge tone={JOB_TONE[job.state] || 'muted'}>{JOB_WORD[job.state] || job.state}</Badge>
          </div>
          {running && (
            <>
              <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={jobPercent(job)} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-accent transition-all" style={{ width: `${jobPercent(job)}%` }} />
              </div>
              <p className="num text-[11px] text-muted">{job.done} of {job.total} symbols{job.step ? `, now ${job.step}` : ''}</p>
            </>
          )}
          {job.error && <p className="text-[11px] text-down">{job.error}</p>}
          {job.failed?.length > 0 && (
            <p className="text-[11px] leading-snug text-warn">
              Could not finish {job.failed.length} of {job.total}: {failedText(job.failed)}. Press the button again to retry; what is saved is kept.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
