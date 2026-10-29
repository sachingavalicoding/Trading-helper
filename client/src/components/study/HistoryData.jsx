import { useEffect, useState } from 'react';
import { Database, Download } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { failedText, jobPercent, liveText, savedText, SYNC_LABEL } from '../../lib/history.js';
import { Badge, Card, Skeleton } from '../ui.jsx';

const JOB_TONE = { running: 'accent', done: 'up', partial: 'warn', failed: 'down' };
const JOB_WORD = { running: 'Downloading', done: 'Finished', partial: 'Finished, some failed', failed: 'Failed' };

/** Account > Studies > Data: the three months of 1-minute candles saved in the database, which the studies and Review read. */
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
