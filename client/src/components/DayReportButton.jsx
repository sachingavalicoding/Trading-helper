import { useState } from 'react';
import { ClipboardCopy } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';
import { copyText } from '../lib/copyText.js';
import { Card } from './ui.jsx';

/** One tap: gather today's scanner ideas, auto and option trades, skips and news calls as text, and copy it to paste into the chat. */
export function DayReportButton() {
  const [busy, setBusy] = useState(false);
  const [day, setDay] = useState('');
  const [text, setText] = useState(null);

  async function build() {
    setBusy(true);
    try {
      const r = await api(`/report/day${day ? `?day=${day}` : ''}`);
      setText(r.text);
      const ok = await copyText(r.text);
      toast[ok ? 'success' : 'info'](ok ? `Report for ${r.day} copied. Paste it into the chat.` : 'Could not copy by itself. Press and hold the text below, then copy.');
    } catch (e) {
      toast.error(e.message || 'Could not build the report');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">Day report</div>
          <p className="text-[11px] leading-snug text-muted">Ideas, auto and option trades, skips, news calls and the rules in force, as one text to paste into the chat.</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Report day (empty = today)" className="num min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent" />
        <button type="button" onClick={build} disabled={busy} className="btn btn-primary btn-sm shrink-0">
          <ClipboardCopy className="h-3.5 w-3.5" /> {busy ? 'Building…' : 'Copy report'}
        </button>
      </div>
      {text && <textarea readOnly value={text} rows={8} onFocus={(e) => e.target.select()} className="num w-full rounded-lg border border-line bg-surface-2 p-2 text-[11px] leading-snug text-fg outline-none" />}
    </Card>
  );
}
