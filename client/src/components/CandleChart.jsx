import { useCallback, useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';
import { ZoomIn, ZoomOut, RotateCcw, Maximize2, Minimize2, Activity, X, Check } from 'lucide-react';
import { api } from '../lib/api.js';
import { subscribeTick, getTick } from '../lib/tickStore.js';
import { INTERVAL_SEC, applyTick, toChartTime } from '../lib/chart.js';
import { INDICATORS, DEFAULT_INDICATORS, addIndicator } from '../lib/chartIndicators.js';
import { formatPrice, formatQtyCompact } from '../lib/format.js';
import { useTheme } from '../context/ThemeContext.jsx';
import { Segmented, Skeleton } from './ui.jsx';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const withAlpha = (hex, a) => {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const STORE_KEY = 'npt_indicators';
const loadIndicators = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (Array.isArray(saved)) return saved.filter((id) => INDICATORS.some((i) => i.id === id));
  } catch {
    /* ignore */
  }
  return DEFAULT_INDICATORS;
};
const DEFAULT_BARS = { '1m': 90, '5m': 75, '15m': 60 };

function ToolButton({ label, onClick, active, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-8 min-w-8 items-center justify-center gap-1 rounded-md px-1.5 text-xs font-medium ${active ? 'bg-accent text-white' : 'text-muted hover:bg-surface-2 hover:text-fg'}`}
    >
      {children}
    </button>
  );
}

/**
 * TradingView-style candlestick chart: 1m/5m/15m, indicators (VWAP, EMA, SMA, Bollinger,
 * RSI, MACD, volume), zoom buttons plus pinch / wheel / axis-drag zoom, and fullscreen.
 * `lines` draws horizontal price lines (position average, stop-loss, target).
 */
export function CandleChart({ symbol, isIndex = false, lines = [] }) {
  const { theme } = useTheme();
  const [interval, setIntervalValue] = useState('5m');
  const [indicators, setIndicators] = useState(loadIndicators);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [legend, setLegend] = useState(null);
  const [state, setState] = useState({ loading: true, error: null, simulated: false });

  const wrapRef = useRef(null);
  const elRef = useRef(null);
  const chartRef = useRef(null); // { chart, candles, items: [{ series, compute }] }
  const dataRef = useRef({ key: null, candles: [] });

  const active = indicators.filter((id) => !(isIndex && INDICATORS.find((i) => i.id === id)?.needsVolume));
  const activeKey = active.join(',');

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(indicators));
    } catch {
      /* ignore */
    }
  }, [indicators]);

  const showDefaultRange = useCallback(() => {
    const c = chartRef.current;
    const n = dataRef.current.candles.length;
    if (!c || !n) return;
    const bars = Math.min(n, DEFAULT_BARS[interval] || 75);
    c.chart.timeScale().setVisibleLogicalRange({ from: n - bars, to: n + 3 });
    c.candles.priceScale().applyOptions({ autoScale: true });
  }, [interval]);

  const paintAll = useCallback(() => {
    const c = chartRef.current;
    const { candles } = dataRef.current;
    if (!c) return;
    c.candles.setData(candles);
    for (const it of c.items) it.series.setData(it.compute(candles));
  }, []);

  // Build the chart. Rebuilt when theme or indicator set changes (cheap; data is cached in dataRef).
  useEffect(() => {
    const el = elRef.current;
    if (!el) return undefined;
    const up = cssVar('--up');
    const down = cssVar('--down');
    const border = cssVar('--border');
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 11, panes: { separatorColor: border } },
      grid: { vertLines: { color: withAlpha(border, 0.35) }, horzLines: { color: withAlpha(border, 0.35) } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: { time: true, price: true } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: active.includes('volume') ? 0.22 : 0.06 } });

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
      setLegend(bar ? { ...bar, volume: dataRef.current.candles.find((c) => c.time === p.time)?.volume } : null);
    });

    chartRef.current = { chart, candles, items };
    if (dataRef.current.candles.length) {
      paintAll();
      showDefaultRange();
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
        showDefaultRange();
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
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [symbol, interval, paintAll, showDefaultRange]);

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

  // Fullscreen: real browser fullscreen where supported (Android, desktop), CSS overlay otherwise (iPhone).
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

  const zoom = (factor) => {
    const c = chartRef.current;
    const n = dataRef.current.candles.length;
    const ts = c?.chart.timeScale();
    const r = ts?.getVisibleLogicalRange();
    if (!r) return;
    const len = r.to - r.from;
    const next = Math.min(Math.max(len * factor, 10), n + 50);
    ts.setVisibleLogicalRange({ from: r.to - next, to: r.to });
  };

  const toggleIndicator = (id) => setIndicators((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const legendTone = legend ? (legend.close >= legend.open ? 'text-up' : 'text-down') : '';
  const available = INDICATORS.filter((i) => !(isIndex && i.needsVolume));
  const activeDefs = active.map((id) => INDICATORS.find((i) => i.id === id));

  return (
    <div ref={wrapRef} className={fullscreen ? 'fixed inset-0 z-[60] flex flex-col bg-bg p-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))]' : ''}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {fullscreen && <span className="mr-1 text-sm font-bold">{symbol}</span>}
        <Segmented
          size="sm"
          value={interval}
          onChange={setIntervalValue}
          options={[
            { value: '1m', label: '1m' },
            { value: '5m', label: '5m' },
            { value: '15m', label: '15m' },
          ]}
        />
        <div className="relative">
          <ToolButton label="Indicators" onClick={() => setPickerOpen((v) => !v)} active={pickerOpen}>
            <Activity className="h-4 w-4" /> <span>Indicators</span>
          </ToolButton>
          {pickerOpen && (
            <>
              <button type="button" aria-label="Close indicators" className="fixed inset-0 z-[70] cursor-default" onClick={() => setPickerOpen(false)} />
              <div className="fixed inset-x-4 top-1/4 z-[71] rounded-xl border border-line bg-surface p-1 shadow-xl sm:absolute sm:inset-x-auto sm:top-auto sm:left-0 sm:mt-1 sm:w-64" role="menu">
                {available.map((i) => {
                  const on = indicators.includes(i.id);
                  return (
                    <button key={i.id} type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => toggleIndicator(i.id)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-surface-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: i.color }} />
                      <span className="flex-1">{i.label}</span>
                      {on && <Check className="h-4 w-4 text-accent" />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
        <div className="ml-auto flex items-center">
          <ToolButton label="Zoom out" onClick={() => zoom(1.4)}>
            <ZoomOut className="h-4 w-4" />
          </ToolButton>
          <ToolButton label="Zoom in" onClick={() => zoom(0.7)}>
            <ZoomIn className="h-4 w-4" />
          </ToolButton>
          <ToolButton label="Reset view" onClick={showDefaultRange}>
            <RotateCcw className="h-4 w-4" />
          </ToolButton>
          <ToolButton label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={() => setFullscreen((v) => !v)}>
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </ToolButton>
        </div>
      </div>

      {activeDefs.length > 0 && (
        <div className="no-scrollbar mb-1 flex gap-1.5 overflow-x-auto">
          {activeDefs.map((i) => (
            <span key={i.id} className="flex shrink-0 items-center gap-1 rounded-md bg-surface-2 py-0.5 pr-0.5 pl-2 text-[11px] text-muted">
              <span className="h-2 w-2 rounded-full" style={{ background: i.color }} />
              {i.label}
              <button type="button" aria-label={`Remove ${i.label}`} onClick={() => toggleIndicator(i.id)} className="rounded p-0.5 hover:text-fg">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={`relative w-full ${fullscreen ? 'min-h-0 flex-1' : active.some((id) => INDICATORS.find((i) => i.id === id)?.pane) ? 'h-[62vh] max-h-[600px] min-h-[360px]' : 'h-[52vh] max-h-[460px] min-h-[280px]'}`}>
        <div ref={elRef} className="absolute inset-0" />
        {legend && (
          <div className="num pointer-events-none absolute top-1 left-1 z-10 flex flex-wrap gap-x-2 rounded bg-bg/70 px-1.5 py-0.5 text-[11px]">
            <span className="text-muted">O <span className={legendTone}>{formatPrice(legend.open)}</span></span>
            <span className="text-muted">H <span className={legendTone}>{formatPrice(legend.high)}</span></span>
            <span className="text-muted">L <span className={legendTone}>{formatPrice(legend.low)}</span></span>
            <span className="text-muted">C <span className={legendTone}>{formatPrice(legend.close)}</span></span>
            {!isIndex && legend.volume != null && <span className="text-muted">V {formatQtyCompact(legend.volume)}</span>}
          </div>
        )}
        {state.loading && <Skeleton className="absolute inset-0" />}
        {state.error && <div className="absolute inset-0 flex items-center justify-center text-sm text-down">{state.error}</div>}
      </div>
      {state.simulated && !fullscreen && <p className="mt-1 text-[11px] text-warn">Simulated prices from the mock feed, not real market data.</p>}
      {!fullscreen && <p className="mt-1 text-[11px] text-muted">Pinch or scroll to zoom, drag to pan, drag the price axis to stretch, double-tap an axis to reset.</p>}
    </div>
  );
}
