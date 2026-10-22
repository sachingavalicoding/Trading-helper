import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';
import { api } from '../lib/api.js';
import { subscribeTick, getTick } from '../lib/tickStore.js';
import { INTERVAL_SEC, applyTick, computeVwap, toChartTime } from '../lib/chart.js';
import { useTheme } from '../context/ThemeContext.jsx';
import { Segmented, Skeleton } from './ui.jsx';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const withAlpha = (hex, a) => {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/**
 * Candlestick chart with volume bars and session VWAP. `lines` draws horizontal price
 * lines (position average, stop-loss, target).
 */
export function CandleChart({ symbol, isIndex = false, lines = [] }) {
  const { theme } = useTheme();
  const [interval, setIntervalValue] = useState('5m');
  const [state, setState] = useState({ loading: true, error: null, simulated: false });
  const elRef = useRef(null);
  const seriesRef = useRef(null);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return undefined;
    const up = cssVar('--up');
    const down = cssVar('--down');
    const text = cssVar('--muted');
    const border = cssVar('--border');

    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: text, fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: withAlpha(border, 0.35) }, horzLines: { color: withAlpha(border, 0.35) } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
    candles.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: isIndex ? 0.06 : 0.24 } });
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    const vwap = chart.addSeries(LineSeries, { color: cssVar('--warn'), lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: 'VWAP' });

    seriesRef.current = { chart, candles, volume, vwap, up, down };
    return () => {
      chart.remove();
      seriesRef.current = null;
    };
  }, [theme, isIndex]);

  // Load history and stream live ticks into the last bar.
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return undefined;
    let alive = true;
    let data = [];
    const tickState = { lastVolume: getTick(symbol)?.volume ?? null };
    const sec = INTERVAL_SEC[interval];
    const volColor = (c) => withAlpha(c.close >= c.open ? s.up : s.down, 0.45);

    setState((p) => ({ ...p, loading: true, error: null }));
    api(`/market/candles/${encodeURIComponent(symbol)}?interval=${interval}`)
      .then((res) => {
        if (!alive) return;
        data = res.candles.map((c) => ({ ...c, time: toChartTime(c.time) }));
        s.candles.setData(data);
        s.volume.setData(isIndex ? [] : data.map((c) => ({ time: c.time, value: c.volume, color: volColor(c) })));
        s.vwap.setData(isIndex ? [] : computeVwap(data));
        const visible = Math.min(data.length, interval === '1m' ? 90 : 75);
        if (data.length) s.chart.timeScale().setVisibleLogicalRange({ from: data.length - visible, to: data.length + 3 });
        setState({ loading: false, error: null, simulated: res.simulated });
      })
      .catch((err) => alive && setState({ loading: false, error: err.message, simulated: false }));

    const unsub = subscribeTick(symbol, () => {
      const t = getTick(symbol);
      if (!t || !data.length) return;
      const bar = applyTick(data, t, sec, tickState);
      if (!bar) return;
      s.candles.update(bar);
      if (!isIndex) {
        s.volume.update({ time: bar.time, value: bar.volume, color: volColor(bar) });
        const v = computeVwap(data.slice(-Math.ceil(86400 / sec)));
        if (v.length) s.vwap.update(v[v.length - 1]);
      }
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [symbol, interval, theme, isIndex]);

  // Position / SL / target lines.
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return undefined;
    const created = lines.filter((l) => l.price).map((l) => s.candles.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: l.title }));
    return () => {
      // The chart may already be disposed if theme/interval changed in the same commit.
      if (seriesRef.current === s) created.forEach((pl) => s.candles.removePriceLine(pl));
    };
  }, [lines, theme, interval]);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
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
        {!isIndex && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className="h-0.5 w-4 rounded bg-warn" /> VWAP
          </span>
        )}
      </div>
      <div className="relative h-[52vh] max-h-[460px] min-h-[280px] w-full">
        <div ref={elRef} className="absolute inset-0" />
        {state.loading && <Skeleton className="absolute inset-0" />}
        {state.error && <div className="absolute inset-0 flex items-center justify-center text-sm text-down">{state.error}</div>}
      </div>
      {state.simulated && <p className="mt-1 text-[11px] text-warn">Simulated prices from the mock feed, not real market data.</p>}
    </div>
  );
}
