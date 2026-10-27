import { useEffect, useRef } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, ColorType, LineStyle } from 'lightweight-charts';
import { toChartTime } from '../lib/chart.js';
import { useTheme } from '../context/ThemeContext.jsx';

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** The bar a moment falls in: before the first bar it sits on the first, after the last on the last. */
export function barTime(candles, at) {
  if (!candles.length) return null;
  const t = toChartTime(new Date(at).getTime() / 1000);
  let hit = candles[0].time;
  for (const c of candles) {
    if (c.time <= t) hit = c.time;
    else break;
  }
  return hit;
}

/**
 * One finished (or running) day as 5-minute candles, with the open and previous close drawn across it
 * and a marker where each headline, scanner idea or trade of yours came in.
 * `marks`: [{ at, text, kind: 'news-up' | 'news-down' | 'buy' | 'sell' }]
 */
export function ReviewChart({ candles, open, prevClose, marks = [], height = 260 }) {
  const ref = useRef(null);
  const { theme } = useTheme();

  useEffect(() => {
    if (!ref.current || !candles?.length) return undefined;
    const up = cssVar('--up');
    const down = cssVar('--down');
    const border = cssVar('--border');
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: border } },
      rightPriceScale: { borderVisible: false, minimumWidth: 52 },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      handleScroll: { horzTouchDrag: true, pressedMouseMove: true, vertTouchDrag: false },
      handleScale: { pinch: true, mouseWheel: true },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
    series.setData(candles.map((c) => ({ time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    if (open) series.createPriceLine({ price: open, color: cssVar('--accent2'), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Open' });
    if (prevClose) series.createPriceLine({ price: prevClose, color: cssVar('--muted'), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: 'Prev close' });
    const shaped = marks
      .map((m) => ({ ...m, time: barTime(candles.map((c) => ({ time: toChartTime(c.time) })), m.at) }))
      .filter((m) => m.time != null)
      .sort((a, b) => a.time - b.time)
      .map((m) => ({
        time: m.time,
        position: m.kind === 'news-down' || m.kind === 'sell' ? 'aboveBar' : 'belowBar',
        shape: m.kind === 'news-down' || m.kind === 'sell' ? 'arrowDown' : 'arrowUp',
        color: m.kind.startsWith('news') ? cssVar('--accent2') : m.kind === 'buy' ? up : down,
        text: m.text,
      }));
    createSeriesMarkers(series, shaped);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles, open, prevClose, marks, theme]);

  if (!candles?.length) {
    return (
      <div style={{ height: height / 2 }} className="flex items-center justify-center rounded-xl bg-surface-2 px-6 text-center text-xs text-muted">
        No intraday chart for this day. The broker keeps only the last few sessions of minute candles.
      </div>
    );
  }
  return <div ref={ref} style={{ height }} className="w-full" />;
}
