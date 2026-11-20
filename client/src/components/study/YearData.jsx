import { useEffect, useRef, useState } from 'react';
import { Archive, Download, Mail, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api, downloadFile, uploadFile } from '../../lib/api.js';
import { useApi } from '../../lib/useApi.js';
import { dayText, failedText, sizeText } from '../../lib/history.js';
import { Badge, Card, Skeleton } from '../ui.jsx';

const TONE = { running: 'accent', done: 'up', partial: 'warn', failed: 'down' };
const WORD = { running: 'Working', done: 'Finished', partial: 'Finished, some failed', failed: 'Failed' };

/** Polls the endpoint while a background job runs. */
function usePoll(running, data, reload) {
  useEffect(() => {
    if (!running) return undefined;
    const t = setTimeout(reload, 3000);
    return () => clearTimeout(t);
  }, [running, data, reload]);
}

/** Research > Data: a year of real 1-minute candles kept as compressed files (not in the database), with download and import. */
export function YearFiles() {
  const { data, error, reload } = useApi('/year-data');
  const [busy, setBusy] = useState(false);
  const pick = useRef(null);
  const job = data?.job;
  const running = job?.state === 'running';
  usePoll(running, data, reload);

  async function run(fn, ok) {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      reload();
    } catch (e) {
      toast.error(e.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return null;
  if (!data) return <Skeleton className="h-32" />;
  const pct = job?.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;

  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <Archive size={16} className="text-accent" aria-hidden />
        <h3 className="text-sm font-semibold">Year files (deep study)</h3>
        {job && job.state !== 'idle' && <Badge tone={TONE[job.state] || 'muted'}>{WORD[job.state] || job.state}</Badge>}
      </div>
      <p className="text-[11px] leading-snug text-muted">{data.note}</p>
      {data.simulated && <p className="text-[11px] text-warn">The sample feed has no real history. Log in to Upstox first.</p>}
      {running && (
        <>
          <div className="h-1.5 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="num text-[11px] text-muted">{job.done} of {job.total}, now {job.step}</p>
        </>
      )}
      {job?.error && <p className="text-[11px] text-down">{job.error}</p>}
      {job?.failed?.length > 0 && <p className="text-[11px] leading-snug text-warn">Could not read {job.failed.length}: {failedText(job.failed)}. Press the button again to continue; what is saved is kept.</p>}
      <button type="button" className="btn btn-primary w-full" disabled={busy || running || data.simulated} onClick={() => run(() => api('/year-data/download', { method: 'POST', body: { months: 12 } }), 'Downloading the last 12 months')}>
        <Download size={16} aria-hidden />
        {running ? 'Downloading…' : data.files.length ? 'Download / continue the last 12 months' : 'Download the last 12 months'}
      </button>

      {data.files.length > 0 && (
        <ul className="space-y-1.5">
          {data.files.map((f) => (
            <li key={f.name} className="flex items-center justify-between gap-2 rounded-lg border border-line p-2">
              <div className="min-w-0">
                <p className="num truncate text-xs font-medium">{f.name}</p>
                <p className="num text-[11px] text-muted">{f.days ? `${f.days} days, ${dayText(f.from)} to ${dayText(f.to)}, ` : ''}{sizeText(f.bytes)}</p>
              </div>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(() => downloadFile(`/year-data/files/${f.name}`, f.name))}>
                <Download size={14} aria-hidden /> Save
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        ref={pick}
        type="file"
        accept=".gz,application/gzip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) run(() => uploadFile(`/year-data/import?name=${encodeURIComponent(file.name)}`, file), 'File loaded for a test');
        }}
      />
      <button type="button" className="btn w-full" disabled={busy} onClick={() => pick.current?.click()}>
        <Upload size={16} aria-hidden /> Import a year file for a test
      </button>
      {data.imports.length > 0 && (
        <ul className="space-y-1.5">
          {data.imports.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-2 rounded-lg border border-line p-2">
              <div className="min-w-0">
                <p className="num truncate text-xs font-medium">{i.name || `${i.group}-${i.year}`}</p>
                <p className="num text-[11px] text-muted">Loaded for a test, {dayText(i.from)} to {dayText(i.to)}. Deletes itself {new Date(i.expiresAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.</p>
              </div>
              <button type="button" className="btn btn-sm" aria-label="Delete this import now" disabled={busy} onClick={() => run(() => api(`/year-data/imports/${i.id}`, { method: 'DELETE' }), 'Deleted')}>
                <Trash2 size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Research > Data: the real option data of each month, as a file to download and as a monthly email. */
export function OptionMail() {
  const { data, error, reload } = useApi('/year-data/options');
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState(null);
  const job = data?.job;
  const running = job?.state === 'running';
  usePoll(running, data, reload);

  async function run(fn, ok) {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      reload();
    } catch (e) {
      toast.error(e.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return null;
  if (!data) return <Skeleton className="h-32" />;
  const email = to ?? data.recipient;

  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center gap-2">
        <Mail size={16} className="text-accent" aria-hidden />
        <h3 className="text-sm font-semibold">Monthly option data by email</h3>
        {job && job.state !== 'idle' && <Badge tone={TONE[job.state] || 'muted'}>{WORD[job.state] || job.state}</Badge>}
      </div>
      <p className="text-[11px] leading-snug text-muted">The real option contract data saved each evening is kept 30 days in the database. On the first of each month the month just ended is made into a compressed file and emailed, so it stays for study. A big month goes as several mails, each under the mail size limit.</p>
      {!data.mailReady && <p className="text-[11px] leading-snug text-warn">Email is not set up on the server yet (SMTP_USER and SMTP_PASS). Files are still made and can be downloaded below.</p>}
      {job?.error && <p className="text-[11px] text-down">{job.error}</p>}
      {running && <p className="num text-[11px] text-muted">{job.month}: {job.step}</p>}
      <label className="block text-[11px] text-muted" htmlFor="mail-to">Send to</label>
      <div className="flex gap-2">
        <input id="mail-to" type="email" inputMode="email" className="field min-w-0 flex-1" value={email} onChange={(e) => setTo(e.target.value)} />
        <button type="button" className="btn" disabled={busy || email === data.recipient} onClick={() => run(() => api('/year-data/options/recipient', { method: 'PUT', body: { to: email } }).then(() => setTo(null)), 'Saved')}>Save</button>
      </div>
      {data.months.length === 0 && <p className="text-xs text-muted">No option data saved yet.</p>}
      <ul className="space-y-1.5">
        {data.months.map((m) => (
          <li key={m.month} className="space-y-1.5 rounded-lg border border-line p-2">
            <p className="num text-xs font-medium">{m.month}{m.sent.length > 0 && <span className="ml-2 text-[11px] font-normal text-up">emailed {m.sent.length} file{m.sent.length > 1 ? 's' : ''}</span>}</p>
            {m.files.map((f) => (
              <button key={f.name} type="button" className="btn btn-sm w-full justify-between" disabled={busy} onClick={() => run(() => downloadFile(`/year-data/options/files/${f.name}`, f.name))}>
                <span className="num truncate">{f.name}</span>
                <span className="num">{sizeText(f.bytes)}</span>
              </button>
            ))}
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn btn-sm" disabled={busy || running || !(m.inDatabase || m.files.length)} onClick={() => run(() => api('/year-data/options/send', { method: 'POST', body: { month: m.month, email: false } }), 'Making the file')}>
                Make file
              </button>
              <button type="button" className="btn btn-sm" disabled={busy || running || !data.mailReady || !(m.inDatabase || m.files.length)} onClick={() => run(() => api('/year-data/options/send', { method: 'POST', body: { month: m.month, email: true } }), 'Sending the email')}>
                Email it now
              </button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
