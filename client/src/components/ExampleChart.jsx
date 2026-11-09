import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, createSeriesMarkers, BarSeries, ColorType, CrosshairMode } from 'lightweight-charts';
import { toChartTime } from '../lib/chart.js';
import { useApi } from '../lib/useApi.js';
import { useTheme } from '../context/ThemeContext.jsx';
import { Segmented } from './ui.jsx';
import { snapTime } from './DayChart.jsx';
import { exampleWords, entryClock } from '../lib/examples.js';

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/**
 * The Nifty as simple price bars (5-minute) with an arrow wherever the check would have bought: up for a call, down for a put.
 * Drag or pinch to look closer. `bars`: [{ time, open, high, low, close }]. `entries`: [{ time, side }]. `selected`: an entry time or null.
 */
export function NiftyBars({ bars, entries, selected, height = 240 }) {
  const theme = useTheme()?.theme;
  const el = useRef(null);
  const live = useRef({});

  useEffect(() => {
    if (!el.current || !bars.length) return undefined;
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: cssVar('--border') } },
      rightPriceScale: { borderVisible: false, minimumWidth: 52 },
      timeScale: { borderVisible: false, timeVisible: true, rightOffset: 2, minBarSpacing: 0.5 },
      crosshair: { mode: CrosshairMode.Magnet },
      kineticScroll: { touch: true, mouse: false },
      handleScroll: { horzTouchDrag: true, pressedMouseMove: true, vertTouchDrag: false },
    });
    const series = chart.addSeries(BarSeries, { upColor: cssVar('--up'), downColor: cssVar('--down'), thinBars: true, priceLineVisible: false, lastValueVisible: false });
    const data = bars.map((b) => ({ time: toChartTime(b.time), open: b.open, high: b.high, low: b.low, close: b.close }));
    series.setData(data);
    chart.timeScale().fitContent();
    live.current = { times: data.map((b) => b.time), marks: createSeriesMarkers(series, []) };
    return () => {
      chart.remove();
      live.current = {};
    };
  }, [bars, theme]);

  useEffect(() => {
    const { marks, times } = live.current;
    if (!marks) return;
    const up = cssVar('--up');
    const down = cssVar('--down');
    // an entry is bought as its signal bar closes, so the arrow sits on that bar (the one that starts 5 minutes before the entry time)
    marks.setMarkers(
      entries
        .map((e) => {
          const call = e.side === 'CE';
          const on = e.time === selected;
          return { time: snapTime(times, toChartTime(e.time - 300)), position: call ? 'belowBar' : 'aboveBar', shape: call ? 'arrowUp' : 'arrowDown', color: call ? up : down, size: on ? 2 : 1, text: on ? (call ? 'Call' : 'Put') : '' };
        })
        .sort((a, b) => a.time - b.time),
    );
  }, [entries, selected, bars, theme]);

  return <div ref={el} style={{ height }} className="w-full" role="img" aria-label="Nifty 5-minute bars with an arrow at each entry this check would have taken" />;
}

/** The info sheet's chart: where this check (or these checks together) would have bought on the last few days, and what happened next. */
export function CheckExamples({ keys }) {
  const [days, setDays] = useState(5);
  const [selected, setSelected] = useState(null);
  const path = keys.length ? `/lab/examples?keys=${encodeURIComponent(keys.join(','))}&days=${days}` : null;
  const { data, error, loading } = useApi(path, []);
  const words = useMemo(() => (data ? exampleWords(data) : null), [data]);
  return (
    <section className="space-y-2 rounded-xl border border-line p-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold">Where it would have bought</p>
        <Segmented size="sm" value={days} onChange={(v) => { setDays(v); setSelected(null); }} options={[3, 5, 10].map((d) => ({ value: d, label: `${d} days` }))} />
      </div>
      {loading && !data && <div className="h-[240px] animate-pulse rounded-lg bg-surface-2" />}
      {error && <p className="text-[11px] leading-snug text-warn">{error.message || 'Could not load the chart.'}</p>}
      {data?.bars && (
        <>
          <NiftyBars bars={data.bars} entries={data.entries} selected={selected} />
          <p className="text-[11px] leading-snug text-muted">{words}</p>
          {data.entries.length > 0 && (
            <ul className="max-h-48 divide-y divide-line overflow-y-auto text-[11px]">
              {[...data.entries].reverse().map((e) => (
                <li key={`${e.time}-${e.side}`}>
                  <button type="button" onClick={() => setSelected(selected === e.time ? null : e.time)} className={`flex w-full items-center justify-between gap-2 py-1.5 text-left ${selected === e.time ? 'font-semibold' : ''}`}>
                    <span>
                      <span className={e.side === 'CE' ? 'text-up' : 'text-down'}>{e.side === 'CE' ? '▲ Call' : '▼ Put'}</span> {entryClock(e.time)} at {e.price}
                    </span>
                    <span className={`num ${e.after == null ? 'text-muted' : e.after > 0 ? 'text-up' : 'text-down'}`}>{e.after == null ? 'day ended' : `${e.after > 0 ? '+' : ''}${e.after} pts in 30 min`}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] leading-snug text-muted">Arrows are where it turned true on a closed 5-minute bar (the same rule the bot uses, without your other limits). Points are the Nifty move in the trade direction 30 minutes later, not option profit.</p>
        </>
      )}
    </section>
  );
}
