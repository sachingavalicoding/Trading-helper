import { useRef, useState } from 'react';
import { Copy, Download, FileUp, ClipboardPaste } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';
import { CodeError, decodeSettings, encodeSettings, readDevice, writeDevice } from '../lib/settingsCode.js';

const when = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown date';
};

/** Everything saved for this login, with this phone's own choices, as the file. */
async function loadFile() {
  const file = await api('/settings-transfer/export');
  return { ...file, device: readDevice() };
}

function ExportPart() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const box = useRef(null);

  const download = async () => {
    setBusy('file');
    try {
      const file = await loadFile();
      const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `trade-helper-settings-${file.exportedAt.slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast.success('Settings file saved to Downloads.');
    } catch (e) {
      toast.error(e.message || 'Could not make the file');
    } finally {
      setBusy('');
    }
  };

  const copy = async () => {
    setBusy('code');
    try {
      const text = await encodeSettings(await loadFile());
      setCode(text);
      try {
        await navigator.clipboard.writeText(text);
        toast.success('Code copied. Paste it in the other app: More > Settings > Copy settings > Import.');
      } catch {
        toast('Copy the code below by hand (long-press, Select all, Copy).');
        setTimeout(() => box.current?.select(), 50);
      }
    } catch (e) {
      toast.error(e.message || 'Could not make the code');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold">Export (from this app)</div>
      <p className="text-xs leading-snug text-muted">Every setting of both bots, the stop and profit lock, all your combinations with their own settings, and the learner switches. No login, keys, trades, orders or P&amp;L.</p>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={download} disabled={!!busy} className="btn btn-secondary w-full">
          <Download className="h-4 w-4" /> {busy === 'file' ? 'Making…' : 'Download file'}
        </button>
        <button type="button" onClick={copy} disabled={!!busy} className="btn btn-secondary w-full">
          <Copy className="h-4 w-4" /> {busy === 'code' ? 'Making…' : 'Copy code'}
        </button>
      </div>
      {code && (
        <label className="block text-xs text-muted">
          Settings code ({code.length.toLocaleString('en-IN')} letters). Send it on WhatsApp or any chat.
          <textarea ref={box} readOnly value={code} rows={3} onFocus={(e) => e.target.select()} className="field mt-1 w-full break-all font-mono text-[11px]" aria-label="Settings code" />
        </label>
      )}
    </div>
  );
}

function Preview({ p }) {
  return (
    <div className="space-y-2 rounded-xl border border-line p-3 text-xs">
      <p className="leading-snug">
        File made on <b>{when(p.exportedAt)}</b>. <b>{p.total === 0 ? 'Nothing changes: the settings are the same.' : `${p.total} change${p.total === 1 ? '' : 's'}.`}</b>
      </p>
      {p.sections.map((s) => {
        const c = s.combos;
        const comboLines = c ? [c.added.length && `Added: ${c.added.join(', ')}`, c.removed.length && `Removed: ${c.removed.join(', ')}`, c.changed.length && `Changed: ${c.changed.join(', ')}`].filter(Boolean) : [];
        if (!s.changes.length && !comboLines.length) return null;
        return (
          <div key={s.key} className="space-y-1">
            <div className="font-semibold">{s.name}</div>
            {c && (comboLines.length > 0) && (
              <div className="text-muted">
                <div>Combinations after the import: {c.count} ({c.on} on)</div>
                {comboLines.map((l) => <div key={l} className="break-words">{l}</div>)}
              </div>
            )}
            {s.changes.length > 0 && (
              <ul className="space-y-0.5 text-muted">
                {s.changes.map((ch) => (
                  <li key={ch.key} className="flex justify-between gap-2">
                    <span className="min-w-0 break-words">{ch.key}</span>
                    <span className="shrink-0 tabular-nums">{ch.from} → <span className="text-fg">{ch.to}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {p.ignored.length > 0 && <p className="text-warn">Left out (this app does not know them): {p.ignored.join(', ')}</p>}
    </div>
  );
}

function ImportPart() {
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = useRef(null);

  const check = async (raw) => {
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const f = await decodeSettings(raw);
      setPreview(await api('/settings-transfer/preview', { method: 'POST', body: { file: f } }));
      setFile(f);
    } catch (e) {
      setFile(null);
      setError(e instanceof CodeError ? e.message : e.message || 'Could not read the settings');
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 1_000_000) return setError('This file is too big to be a settings file.');
    await check(await f.text());
  };

  const apply = async () => {
    setBusy(true);
    try {
      await api('/settings-transfer', { method: 'PUT', body: { file, confirm: true } });
      writeDevice(file.device);
      toast.success('Settings replaced. Reloading…');
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setError(e.message || 'Could not import');
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <div className="text-sm font-semibold">Import (into this app)</div>
      <button type="button" onClick={() => pick.current?.click()} disabled={busy} className="btn btn-secondary w-full">
        <FileUp className="h-4 w-4" /> Pick a settings file
      </button>
      <input ref={pick} type="file" accept=".json,application/json,text/plain" className="hidden" onChange={onFile} aria-label="Settings file" />
      <label className="block text-xs text-muted">
        …or paste a settings code
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="THS1.…" className="field mt-1 w-full break-all font-mono text-[11px]" aria-label="Paste settings code" />
      </label>
      <button type="button" onClick={() => check(text)} disabled={busy || !text.trim()} className="btn btn-secondary w-full">
        <ClipboardPaste className="h-4 w-4" /> {busy && !preview ? 'Checking…' : 'Check the code'}
      </button>
      {error && <p className="text-xs text-down">{error}</p>}
      {preview && (
        <>
          <Preview p={preview} />
          <p className="text-xs leading-snug text-warn">This REPLACES all settings and combinations of this login with the file's. Anything not in the file goes back to its default. Trades, orders, P&amp;L and the login are not touched.</p>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => { setPreview(null); setFile(null); }} disabled={busy} className="btn btn-ghost w-full">Cancel</button>
            <button type="button" onClick={apply} disabled={busy} className="btn btn-primary w-full">{busy ? 'Replacing…' : 'Replace my settings'}</button>
          </div>
        </>
      )}
    </div>
  );
}

/** More > Settings > Copy settings: export this login's settings as a file or a code, or import another login's (with a summary first). */
export function SettingsTransfer() {
  return (
    <div className="space-y-3">
      <ExportPart />
      <ImportPart />
    </div>
  );
}
