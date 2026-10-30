import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';
import { Maximize2, X, SlidersHorizontal } from 'lucide-react';
import { toChartTime } from '../lib/chart.js';
import { foldCandles } from '../lib/indicators.js';
import { INDICATORS, addIndicator } from '../lib/chartIndicators.js';
import { formatPrice } from '../lib/format.js';
import { useTheme } from '../context/ThemeContext.jsx';
import { IndicatorSheet, STORE_KEY, loadIndicators } from './CandleChart.jsx';

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const TIMEFRAMES = [
  { id: '1m', sec: 60 },
  { id: '5m', sec: 300 },
  { id: '15m', sec: 900 },
];

/** The bar a moment falls in: the last bar at or before it, the first when it is earlier. */
export function snapTime(times, t) {
  let hit = times[0];
  for (const x of times) {
    if (x <= t) hit = x;
    else break;
  }
  return hit;
}

/** The bars of one timeframe: the day's 1-minute bars as they are, 5-minute bars (with the earlier days before them for the indicators) and 15-minute bars folded from those. */
export function barsFor(tf, { warm = [], candles = [], minutes = [] }) {
  const shift = (list) => list.map((c) => ({ ...c, time: toChartTime(c.time), volume: c.volume ?? 0 }));
  if (tf === '1m') return shift(minutes);
  const five = shift([...warm, ...candles]);
  return tf === '5m' ? five : foldCandles(five, 900);
}

/**
 * One day of the index or a stock as candles, with the same indicator picker, timeframes and fullscreen as the Options chart.
 * The earlier days (`warm`) sit to the left so slow indicators such as EMA 50 are already settled at the open; the view starts at the day.
 * `markers`: [{ id, time (epoch seconds), position, shape, color, text, size }]. `lines`: [{ price, color, title, style }]. `onPick(ids)` when a marker's bar is tapped.
 * `overlays`: [{ id, label, group, count, on }] are patterns and combinations listed in the indicator picker beside the indicators; `onOverlay(id)` switches one.
 */
export function DayChart({ candles, warm = [], minutes = [], isIndex = false, markers = [], lines = [], overlays = [], onOverlay, onPick, height = 320 }) {
  const { theme } = useTheme();
  const [tf, setTf] = useState('5m');
  const [indicators, setIndicators] = useState(loadIndicators);
  const [sheet, setSheet] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [legend, setLegend] = useState(null);
  const elRef = useRef(null);
  const wrapRef = useRef(null);
  const live = useRef({});
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  const available = INDICATORS.filter((i) => !(isIndex && i.needsVolume));
  const active = indicators.filter((id) => available.some((i) => i.id === id));
  const activeKey = active.join(',');
  const hasMinutes = minutes.length > 0;
  const shown = tf === '1m' && !hasMinutes ? '5m' : tf;
  const bars = useMemo(() => barsFor(shown, { warm, candles, minutes }), [shown, warm, candles, minutes]);
  const dayStart = candles?.length ? toChartTime(candles[0].time) : 0;

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(indicators));
    } catch {
      /* the choice is simply not remembered */
    }
  }, [indicators]);

  // the chart: rebuilt for another day, timeframe, theme or indicator set
  useEffect(() => {
    const el = elRef.current;
    if (!el || !bars.length) return undefined;
    const up = cssVar('--up');
    const down = cssVar('--down');
    const border = cssVar('--border');
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 10, panes: { separatorColor: border, enableResize: false } },
      grid: { vertLines: { visible: false }, horzLines: { color: border } },
      rightPriceScale: { borderVisible: false, minimumWidth: 52 },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3, minBarSpacing: 2, maxBarSpacing: 22 },
      crosshair: { mode: CrosshairMode.Magnet },
      kineticScroll: { touch: true, mouse: false },
      handleScroll: { horzTouchDrag: true, pressedMouseMove: true, vertTouchDrag: false },
      handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: { time: true, price: false } },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
    series.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: active.includes('volume') ? 0.2 : 0.06 } });
    let pane = 0;
    const items = [];
    for (const id of active) {
      const def = INDICATORS.find((i) => i.id === id);
      items.push(...addIndicator(chart, id, { up, down, paneIndex: def.pane ? ++pane : 0 }));
    }
    const panes = chart.panes();
    panes[0]?.setStretchFactor(3);
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
    series.setData(bars);
    for (const it of items) it.series.setData(it.compute(bars));
    const first = Math.max(0, bars.findIndex((b) => b.time >= dayStart));
    chart.timeScale().setVisibleLogicalRange({ from: first - 1, to: bars.length + 2 });
    const times = bars.map((b) => b.time);
    chart.subscribeCrosshairMove((p) => {
      const bar = p?.time ? p.seriesData.get(series) : null;
      setLegend(bar ? { ...bar } : null);
    });
    chart.subscribeClick((p) => {
      if (p.time == null) return;
      const hit = (live.current.markers ?? []).filter((m) => snapTime(times, m.time) === p.time).map((m) => m.id);
      if (hit.length) pickRef.current?.(hit);
    });
    live.current = { ...live.current, chart, series, times, marks: createSeriesMarkers(series, []), priceLines: [] };
    setLegend(null);
    return () => {
      chart.remove();
      live.current = { markers: live.current.markers };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, theme, activeKey]);

  // arrows, exits and levels: redrawn without rebuilding the chart
  useEffect(() => {
    const { series, marks, times } = live.current;
    live.current.markers = markers;
    if (!series || !marks) return;
    for (const l of live.current.priceLines) series.removePriceLine(l);
    live.current.priceLines = lines.filter((l) => l.price).map((l) => series.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style ?? LineStyle.Dashed, axisLabelVisible: true, title: l.title }));
    marks.setMarkers(
      markers
        .map((m) => ({ time: snapTime(times, Math.max(toChartTime(m.time), dayStart)), position: m.position, shape: m.shape, color: m.color, size: m.size ?? 1, text: m.text }))
        .sort((a, b) => a.time - b.time),
    );
  }, [markers, lines, bars, theme, activeKey, dayStart]);

  useEffect(() => {
    if (!fullscreen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const el = wrapRef.current;
    if (el?.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
    const onKey = (e) => e.key === 'Escape' && setFullscreen(false);
    const onFs = () => !document.fullscreenElement && setFullscreen(false);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [fullscreen]);

  if (!candles?.length) {
    return <div style={{ height: height / 2 }} className="flex items-center justify-center rounded-xl bg-surface-2 px-6 text-center text-xs text-muted">No minute chart for this day. The broker keeps only the last few sessions, and a day you saved under Studies &gt; Data shows here.</div>;
  }
  const toggle = (id) => setIndicators((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const panes = active.filter((id) => INDICATORS.find((i) => i.id === id)?.pane).length;
  const h = height + panes * 90;
  const tone = legend ? (legend.close >= legend.open ? 'text-up' : 'text-down') : '';
  return (
    <div ref={wrapRef} className={fullscreen ? 'fixed inset-0 z-[60] flex flex-col bg-bg px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))]' : ''}>
      <div className="mb-1 flex items-center gap-1">
        {TIMEFRAMES.filter((t) => t.id !== '1m' || hasMinutes).map((t) => (
          <button key={t.id} type="button" onClick={() => setTf(t.id)} aria-pressed={shown === t.id} className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${shown === t.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}>
            {t.id}
          </button>
        ))}
        <button type="button" onClick={() => setSheet(true)} aria-label="Indicators" className="ml-1 flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-muted">
          <SlidersHorizontal className="h-4 w-4" />
          {active.length + overlays.filter((o) => o.on).length > 0 && <span className="rounded bg-surface-2 px-1 text-[10px] text-fg">{active.length + overlays.filter((o) => o.on).length}</span>}
        </button>
        <button type="button" onClick={() => setFullscreen((v) => !v)} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} className="ml-auto rounded-md p-1.5 text-muted">
          {fullscreen ? <X className="h-5 w-5" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>
      <div className={`relative w-full touch-pan-y ${fullscreen ? 'min-h-0 flex-1' : ''}`} style={fullscreen ? undefined : { height: h }}>
        <div ref={elRef} className="absolute inset-0" />
        {legend && (
          <div className="num pointer-events-none absolute top-0 left-0 z-10 flex gap-1.5 text-[10px] leading-4">
            <span className="text-muted">O</span>
            <span className={tone}>{formatPrice(legend.open)}</span>
            <span className="text-muted">H</span>
            <span className={tone}>{formatPrice(legend.high)}</span>
            <span className="text-muted">L</span>
            <span className={tone}>{formatPrice(legend.low)}</span>
            <span className="text-muted">C</span>
            <span className={tone}>{formatPrice(legend.close)}</span>
          </div>
        )}
      </div>
      {sheet && <IndicatorSheet active={active} available={available} onToggle={toggle} onClose={() => setSheet(false)} overlays={overlays} onOverlay={onOverlay} />}
    </div>
  );
}
