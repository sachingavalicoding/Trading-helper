import { useCallback, useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';
import { Maximize2, X, Check, ChevronsRight, SlidersHorizontal } from 'lucide-react';
import { api } from '../lib/api.js';
import { subscribeTick, getTick } from '../lib/tickStore.js';
import { INTERVAL_SEC, applyTick, toChartTime } from '../lib/chart.js';
import { INDICATORS, DEFAULT_INDICATORS, addIndicator } from '../lib/chartIndicators.js';
import { markGesture } from '../lib/useDeliberateTap.js';
import { formatPrice } from '../lib/format.js';
import { useTheme } from '../context/ThemeContext.jsx';
import { Skeleton } from './ui.jsx';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const withAlpha = (hex, a) => {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
export const STORE_KEY = 'npt_indicators';
export const loadIndicators = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (Array.isArray(saved)) return saved.filter((id) => INDICATORS.some((i) => i.id === id));
  } catch {
    /* ignore */
  }
  return DEFAULT_INDICATORS;
};
const DEFAULT_BARS = { '1m': 70, '5m': 60, '15m': 50 };
const TIMEFRAMES = ['1m', '5m', '15m'];
// Bar spacing limits keep pinch-zoom in a useful range instead of zooming to a blur or a single candle.
const MIN_BAR_SPACING = 3;
const MAX_BAR_SPACING = 22;

export function IndicatorSheet({ active, available, onToggle, onClose, overlays = [], onOverlay }) {
  const groups = [...new Set(overlays.map((o) => o.group))];
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="Indicators">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="sheet-in pb-safe relative max-h-[85vh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface sm:max-w-sm sm:rounded-2xl">
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line sm:hidden" />
        <div className="flex items-center justify-between px-4 pt-3 pb-1">
          <h3 className="font-semibold">Indicators</h3>
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-sm font-semibold text-accent">
            Done
          </button>
        </div>
        <ul className="px-2 pb-3">
          {available.map((i) => {
            const on = active.includes(i.id);
            return (
              <li key={i.id}>
                <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => onToggle(i.id)} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm active:bg-surface-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: i.color }} />
                  <span className="flex-1">{i.label}</span>
                  <span className={`flex h-5 w-5 items-center justify-center rounded-md border ${on ? 'border-accent bg-accent text-on-accent' : 'border-line'}`}>{on && <Check className="h-3.5 w-3.5" />}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {groups.map((group) => (
          <div key={group} className="border-t border-line px-2 pt-2 pb-3">
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{group}</div>
            <ul>
              {overlays
                .filter((o) => o.group === group)
                .map((o) => (
                  <li key={o.id}>
                    <button type="button" role="menuitemcheckbox" aria-checked={o.on} onClick={() => onOverlay?.(o.id)} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left text-sm active:bg-surface-2">
                      <span className="flex-1">{o.label}</span>
                      {o.count != null && <span className="num text-xs text-muted">{o.count}</span>}
                      <span className={`flex h-5 w-5 items-center justify-center rounded-md border ${o.on ? 'border-accent bg-accent text-on-accent' : 'border-line'}`}>{o.on && <Check className="h-3.5 w-3.5" />}</span>
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Mobile-first candlestick chart in the spirit of TradingView's app: one slim toolbar
 * (timeframe, indicators, fullscreen), pinch to zoom, drag to pan, tap for the crosshair.
 * `lines` draws horizontal price lines (position average, stop-loss, target).
 */
export function CandleChart({ symbol, isIndex = false, lines = [] }) {
  const { theme } = useTheme();
  const [interval, setIntervalValue] = useState('5m');
  const [indicators, setIndicators] = useState(loadIndicators);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [legend, setLegend] = useState(null);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [state, setState] = useState({ loading: true, error: null, simulated: false });

  const wrapRef = useRef(null);
  const elRef = useRef(null);
  const chartRef = useRef(null); // { chart, candles, items: [{ series, compute }] }
  const dataRef = useRef({ key: null, candles: [] });

  const available = INDICATORS.filter((i) => !(isIndex && i.needsVolume));
  const active = indicators.filter((id) => available.some((i) => i.id === id));
  const activeKey = active.join(',');
  const extraPanes = active.filter((id) => INDICATORS.find((i) => i.id === id)?.pane).length;

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(indicators));
    } catch {
      /* ignore */
    }
  }, [indicators]);

  const showLatest = useCallback(() => {
    const c = chartRef.current;
    const n = dataRef.current.candles.length;
    if (!c || !n) return;
    const bars = Math.min(n, DEFAULT_BARS[interval] || 60);
    c.chart.timeScale().setVisibleLogicalRange({ from: n - bars, to: n + 3 });
    c.candles.priceScale().applyOptions({ autoScale: true });
  }, [interval]);

  const paintAll = useCallback(() => {
    const c = chartRef.current;
    const { candles } = dataRef.current;
    if (!c) return;
    c.candles.setData(candles);
    for (const it of c.items) it.series.setData(it.compute(candles));
    const last = candles[candles.length - 1];
    setLegend(last ? { ...last, live: true } : null);
  }, []);

  // Build the chart. Rebuilt when theme or indicator set changes (data is cached in dataRef).
  useEffect(() => {
    const el = elRef.current;
    if (!el) return undefined;
    const up = cssVar('--up');
    const down = cssVar('--down');
    const border = cssVar('--border');
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 10, panes: { separatorColor: border, enableResize: false } },
      grid: { vertLines: { visible: false }, horzLines: { color: withAlpha(border, 0.3) } },
      rightPriceScale: { borderVisible: false, minimumWidth: 52 },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3, minBarSpacing: MIN_BAR_SPACING, maxBarSpacing: MAX_BAR_SPACING },
      crosshair: { mode: CrosshairMode.Magnet, vertLine: { labelBackgroundColor: cssVar('--surface-2') }, horzLine: { labelBackgroundColor: cssVar('--surface-2') } },
      kineticScroll: { touch: true, mouse: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: false }, axisDoubleClickReset: { time: true, price: true } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: active.includes('volume') ? 0.2 : 0.06 } });

    let pane = 0;
    const items = [];
    for (const id of active) {
      const def = INDICATORS.find((i) => i.id === id);
      items.push(...addIndicator(chart, id, { up, down, paneIndex: def.pane ? ++pane : 0 }));
    }
    const panes = chart.panes();
    panes[0]?.setStretchFactor(3);
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);

    chart.subscribeCrosshairMove((p) => {
      const bar = p?.time ? p.seriesData.get(candles) : null;
      const all = dataRef.current.candles;
      setLegend(bar ? { ...bar, live: false } : all.length ? { ...all[all.length - 1], live: true } : null);
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      const n = dataRef.current.candles.length;
      setAwayFromLatest(Boolean(r && n && r.to < n - 3));
    });

    chartRef.current = { chart, candles, items };
    if (dataRef.current.candles.length) {
      paintAll();
      showLatest();
    }
    return () => {
      chart.remove();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, activeKey]);

  // Load history for symbol/interval, then stream ticks into the last bar.
  useEffect(() => {
    let alive = true;
    const key = `${symbol}|${interval}`;
    const tickState = { lastVolume: getTick(symbol)?.volume ?? null };
    const sec = INTERVAL_SEC[interval];
    dataRef.current = { key, candles: [] };

    setState((p) => ({ ...p, loading: true, error: null }));
    api(`/market/candles/${encodeURIComponent(symbol)}?interval=${interval}`)
      .then((res) => {
        if (!alive) return;
        dataRef.current = { key, candles: res.candles.map((c) => ({ ...c, time: toChartTime(c.time) })) };
        paintAll();
        showLatest();
        setState({ loading: false, error: null, simulated: res.simulated });
      })
      .catch((err) => alive && setState({ loading: false, error: err.message, simulated: false }));

    const unsub = subscribeTick(symbol, () => {
      const t = getTick(symbol);
      const c = chartRef.current;
      const data = dataRef.current.candles;
      if (!t || !c || !data.length || dataRef.current.key !== key) return;
      const bar = applyTick(data, t, sec, tickState);
      if (!bar) return;
      c.candles.update(bar);
      for (const it of c.items) {
        const pts = it.compute(data);
        if (pts.length) it.series.update(pts[pts.length - 1]);
      }
      setLegend((l) => (!l || l.live ? { ...bar, live: true } : l));
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [symbol, interval, paintAll, showLatest]);

  // Position / SL / target lines.
  useEffect(() => {
    const c = chartRef.current;
    if (!c) return undefined;
    const created = lines.filter((l) => l.price).map((l) => c.candles.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.title }));
    return () => {
      // The chart may already be disposed if it was rebuilt in the same commit.
      if (chartRef.current === c) created.forEach((pl) => c.candles.removePriceLine(pl));
    };
  }, [lines, theme, activeKey]);

  // Fullscreen: real browser fullscreen where supported (Android, desktop), full-page overlay otherwise (iPhone).
  useEffect(() => {
    if (!fullscreen) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    chartRef.current?.chart.applyOptions({ handleScroll: { vertTouchDrag: true } });
    const el = wrapRef.current;
    if (el?.requestFullscreen && !document.fullscreenElement) {
      el.requestFullscreen()
        .then(() => screen.orientation?.lock?.('landscape').catch(() => {}))
        .catch(() => {});
    }
    const onKey = (e) => e.key === 'Escape' && setFullscreen(false);
    const onFsChange = () => !document.fullscreenElement && setFullscreen(false);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFsChange);
      chartRef.current?.chart.applyOptions({ handleScroll: { vertTouchDrag: false } });
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      screen.orientation?.unlock?.();
    };
  }, [fullscreen]);

  const toggleIndicator = (id) => setIndicators((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const legendTone = legend ? (legend.close >= legend.open ? 'text-up' : 'text-down') : '';
  const activeDefs = active.map((id) => INDICATORS.find((i) => i.id === id));
  const heightClass = fullscreen ? 'min-h-0 flex-1' : ['h-[320px]', 'h-[420px]', 'h-[500px]'][Math.min(extraPanes, 2)];

  return (
    <div ref={wrapRef} className={fullscreen ? 'fixed inset-0 z-[60] flex flex-col bg-bg px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))]' : ''}>
      {/* One slim toolbar: timeframe · indicators · fullscreen */}
      <div className="mb-1 flex items-center gap-1">
        {fullscreen && <span className="mr-2 text-sm font-bold">{symbol}</span>}
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            type="button"
            onClick={() => setIntervalValue(tf)}
            aria-pressed={interval === tf}
            className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${interval === tf ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
          >
            {tf}
          </button>
        ))}
        <button type="button" onClick={() => setSheetOpen(true)} aria-label="Indicators" className="ml-1 flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-muted">
          <SlidersHorizontal className="h-4 w-4" />
          {active.length > 0 && <span className="rounded bg-surface-2 px-1 text-[10px] text-fg">{active.length}</span>}
        </button>
        <button type="button" onClick={() => setFullscreen((v) => !v)} aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} className="ml-auto rounded-md p-1.5 text-muted">
          {fullscreen ? <X className="h-5 w-5" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>

      <div
        className={`relative w-full touch-pan-y ${heightClass}`}
        onPointerMove={(e) => e.buttons && markGesture()}
        onTouchMove={markGesture}
        onWheel={markGesture}
      >
        <div ref={elRef} className="absolute inset-0" />

        {/* Legend: OHLC of the bar under the crosshair (or the live bar), then active indicators */}
        {legend && (
          <div className="num pointer-events-none absolute top-0 left-0 z-10 text-[10px] leading-4">
            <div className="flex gap-1.5">
              <span className="text-muted">O</span>
              <span className={legendTone}>{formatPrice(legend.open)}</span>
              <span className="text-muted">H</span>
              <span className={legendTone}>{formatPrice(legend.high)}</span>
              <span className="text-muted">L</span>
              <span className={legendTone}>{formatPrice(legend.low)}</span>
              <span className="text-muted">C</span>
              <span className={legendTone}>{formatPrice(legend.close)}</span>
            </div>
            {activeDefs.length > 0 && (
              <button type="button" onClick={() => setSheetOpen(true)} className="pointer-events-auto mt-0.5 flex flex-wrap gap-x-2 text-left text-muted">
                {activeDefs.map((i) => (
                  <span key={i.id} className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: i.color }} />
                    {i.label.replace(/ \(.*\)$/, '')}
                  </span>
                ))}
              </button>
            )}
          </div>
        )}

        {awayFromLatest && !state.loading && (
          <button
            type="button"
            onClick={showLatest}
            aria-label="Jump to latest"
            className="absolute right-14 bottom-8 z-10 flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-muted shadow"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
        )}
        {state.loading && <Skeleton className="absolute inset-0" />}
        {state.error && <div className="absolute inset-0 flex items-center justify-center text-sm text-down">{state.error}</div>}
      </div>
      {state.simulated && !fullscreen && <p className="mt-1 text-[10px] text-warn">Simulated prices (mock feed), not real market data.</p>}

      {sheetOpen && <IndicatorSheet active={active} available={available} onToggle={toggleIndicator} onClose={() => setSheetOpen(false)} />}
    </div>
  );
}
