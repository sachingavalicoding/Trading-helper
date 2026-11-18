import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Blocks, ChevronLeft, GraduationCap, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../lib/api.js';
import { useApi } from '../lib/useApi.js';
import { fromSaved, ruleText, toPayload } from '../lib/combos.js';
import { Badge, Card, Fold, Segmented, Skeleton } from '../components/ui.jsx';
import { ComboBuilder } from '../components/study/ComboBuilder.jsx';
import { ComboEntrySwitch, OptionsTriggers, Switch, buyingOn } from '../components/options/OptionsAutoCard.jsx';
import { ShareSetups, TREND_SCORE } from '../components/study/ReportsStudies.jsx';

// the results of one combination load only when it is opened
const OptionsLab = lazy(() => import('./Lab.jsx').then((m) => ({ default: m.OptionsLab })));
const SharesLab = lazy(() => import('../components/lab/SharesLab.jsx').then((m) => ({ default: m.SharesLab })));

const SEG = 'combos.seg';
const SEGMENTS = [
  { value: 'options', label: 'Options' },
  { value: 'shares', label: 'Shares' },
];
const ENDPOINT = { options: '/options', shares: '/auto' };

const rememberedSeg = () => {
  try {
    return localStorage.getItem(SEG) === 'shares' ? 'shares' : 'options';
  } catch {
    return 'options';
  }
};

/** One line on what the bot of this segment buys on, so the page says what is live before anything else. */
export function botLine(seg, data) {
  if (!data) return 'Loading…';
  const s = data.settings;
  if (seg === 'options') {
    const on = buyingOn(s);
    return `Options bot ${s.enabled ? 'on' : 'off'} · buys on ${on.length ? on.join(', ') : 'nothing yet'}`;
  }
  const off = new Set(s.skipSetups);
  const setups = data.setupChoices.filter((x) => !off.has(x) && (x !== TREND_SCORE || s.trendScore)).length;
  const mine = (s.combos || []).filter((c) => c.on).length;
  return `Shares bot ${s.enabled ? 'on' : 'off'} · ${mine} combination${mine === 1 ? '' : 's'} and ${setups} setup${setups === 1 ? '' : 's'} on`;
}

/** One combination opened: its switch, then every entry over the last days, its order settings (test, then save) and "add an indicator". */
function ComboDetail({ seg, combo, saved, reload, onBack }) {
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    try {
      await api(ENDPOINT[seg], { method: 'PUT', body: { combos: saved.map((c, i) => ({ ...toPayload(fromSaved(c), i), on: c.id === combo.id ? !c.on : c.on })) } });
      reload();
    } catch (e) {
      toast.error(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>
        <ChevronLeft className="h-4 w-4" /> All {seg} combinations
      </button>
      <Card className="flex items-center justify-between gap-3 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-base font-bold">
            <span className="truncate">{combo.name}</span>
            <Badge tone={combo.on ? 'up' : 'muted'}>{combo.on ? 'On' : 'Off'}</Badge>
          </div>
          <div className="text-[11px] text-muted">{ruleText(fromSaved(combo))}</div>
        </div>
        <Switch on={combo.on} disabled={busy} label={`Use ${combo.name}`} onClick={toggle} />
      </Card>
      <Suspense fallback={<Skeleton className="h-64 w-full" />}>
        {seg === 'shares' ? <SharesLab fixedBase={`combo:${combo.id}`} onSaved={reload} /> : <OptionsLab fixedBase={`combo:${combo.id}`} onSaved={reload} />}
      </Suspense>
    </div>
  );
}

/**
 * Combos: the one place for your combinations. Create, edit the checks, switch on or off, delete; tap one for its results and order settings.
 * The other buy triggers (the indicator score and chart patterns for options, the setups for shares) sit below, folded.
 */
export default function Combos() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('seg');
  const seg = asked === 'shares' || asked === 'options' ? asked : rememberedSeg();
  const id = params.get('id');
  const options = useApi('/options', []);
  const auto = useApi('/auto', []);
  const src = seg === 'shares' ? auto : options;
  const saved = src.data?.settings?.combos ?? [];

  const go = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next);
    if (!patch.id) window.scrollTo({ top: 0 });
  };
  const pickSeg = (v) => {
    try {
      localStorage.setItem(SEG, v);
    } catch {
      /* not remembered */
    }
    go({ seg: v, id: '' });
  };

  // a new combination opens by itself once saved, so its order settings are the next thing you see
  const waitNew = useRef(null);
  useEffect(() => {
    if (waitNew.current != null && saved.length > waitNew.current) {
      waitNew.current = null;
      go({ id: saved[saved.length - 1].id });
    }
  }, [saved.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (id) {
    if (!src.data) return <Skeleton className="h-64 w-full" />;
    const combo = saved.find((c) => c.id === id);
    if (!combo) {
      return (
        <Card className="space-y-2 p-4 text-sm">
          <p>This combination is not in your {seg} list any more.</p>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => go({ id: '' })}>
            <ChevronLeft className="h-4 w-4" /> All combinations
          </button>
        </Card>
      );
    }
    return <ComboDetail seg={seg} combo={combo} saved={saved} reload={src.reload} onBack={() => go({ id: '' })} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 px-1">
        <Blocks className="h-5 w-5 text-accent2" />
        <h1 className="text-lg font-bold">Combinations</h1>
      </div>
      <Segmented className="w-full" value={seg} onChange={pickSeg} options={SEGMENTS} />
      <p className="px-1 text-[11px] text-muted">
        {botLine(seg, src.data)}. The bot's switch is on the {seg === 'shares' ? <Link to="/scanner" className="font-semibold text-accent">Scanner</Link> : <Link to="/options" className="font-semibold text-accent">Options</Link>} tab; stops, limits and hours are in <Link to={`/settings?seg=${seg}`} className="font-semibold text-accent">Settings</Link>.
      </p>

      {!src.data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {seg === 'options' && (
            <Card className="p-3">
              <ComboEntrySwitch data={src.data} reload={src.reload} />
            </Card>
          )}
          <ComboBuilder
            key={seg}
            kind={seg}
            endpoint={ENDPOINT[seg]}
            combos={saved}
            reload={src.reload}
            onOpen={(cid) => go({ id: cid })}
            onCreated={() => {
              waitNew.current = saved.length;
            }}
          />
          <Fold id={`combos-other-${seg}`} title="Other buy triggers" summary={seg === 'options' ? 'Indicator score and chart patterns' : 'The scanner setups the bot may buy'}>
            {seg === 'options' ? <OptionsTriggers data={src.data} reload={src.reload} /> : <ShareSetups data={src.data} reload={src.reload} />}
          </Fold>
          <div className="grid grid-cols-2 gap-2">
            <Link to="/research?tab=test&tool=score" className="card-shadow flex flex-col gap-1 rounded-2xl border border-line bg-surface p-3 hover:border-accent2">
              <Search className="h-5 w-5 text-accent2" />
              <span className="text-sm font-semibold">Find new ones</span>
              <span className="text-[11px] text-muted">Studies try every pair of checks; add a winner here</span>
            </Link>
            <Link to="/research?tab=learn&part=settings" className="card-shadow flex flex-col gap-1 rounded-2xl border border-line bg-surface p-3 hover:border-accent2">
              <GraduationCap className="h-5 w-5 text-accent2" />
              <span className="text-sm font-semibold">Tune them</span>
              <span className="text-[11px] text-muted">Learn finds a better ladder and loss cut for each</span>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
