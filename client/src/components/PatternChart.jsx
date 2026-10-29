import { useEffect, useRef } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, ColorType, LineStyle } from 'lightweight-charts';
import { toChartTime } from '../lib/chart.js';
import { codeOf } from '../lib/patternReview.js';
import { formatPnl } from '../lib/format.js';
import { useTheme } from '../context/ThemeContext.jsx';

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** The 5-minute bar a moment (epoch seconds) falls in; after the last bar it sits on the last. */
function barAt(times, sec) {
  let hit = times[0];
  for (const t of times) {
    if (t <= sec) hit = t;
    else break;
  }
  return hit;
}

/**
 * The Nifty day as 5-minute candles with an arrow where each watched pattern formed (up for a call, down for a put).
 * Tap an arrow, or pick the row below, and the chart also draws that trade: the entry, the stop, the level where a profit
 * target would have been hit, and where the profit lock and the target sold.
 * `signals`: the watched ones. `selected`: one of them or null. `onPick(id)`.
 */
export function PatternChart({ candles, signals, selected, onPick, height = 300 }) {
  const ref = useRef(null);
  const live = useRef({});
  const pick = useRef(onPick);
  pick.current = onPick;
  const { theme } = useTheme();

  // the chart itself: rebuilt only for another day or theme
  useEffect(() => {
    if (!ref.current || !candles?.length) return undefined;
    const up = cssVar('--up');
    const down = cssVar('--down');
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 10 },
      grid: { vertLines: { visible: false }, horzLines: { color: cssVar('--border') } },
      rightPriceScale: { borderVisible: false, minimumWidth: 52 },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      handleScroll: { horzTouchDrag: true, pressedMouseMove: true, vertTouchDrag: false },
      handleScale: { pinch: true, mouseWheel: true },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
    const times = candles.map((c) => toChartTime(c.time));
    series.setData(candles.map((c, i) => ({ time: times[i], open: c.open, high: c.high, low: c.low, close: c.close })));
    const markers = createSeriesMarkers(series, []);
    chart.timeScale().fitContent();
    chart.subscribeClick((p) => {
      if (p.time == null) return;
      const at = live.current.signals?.filter((s) => toChartTime(s.time - 300) === p.time) ?? [];
      if (at.length) pick.current(at[0].id);
    });
    live.current = { ...live.current, series, markers, times, lines: [] };
    return () => {
      chart.remove();
      live.current = { signals: live.current.signals };
    };
  }, [candles, theme]);

  // the arrows, the selected trade's lines and its exits
  useEffect(() => {
    const { series, markers, times } = live.current;
    live.current.signals = signals;
    if (!series || !markers) return;
    const up = cssVar('--up');
    const down = cssVar('--down');
    const accent = cssVar('--accent');
    const hot = cssVar('--accent2');
    for (const l of live.current.lines) series.removePriceLine(l);
    live.current.lines = [];
    const shaped = signals.map((s) => {
      const call = s.side === 'CE';
      const on = s.id === selected;
      return {
        time: toChartTime(s.time - 300),
        position: call ? 'belowBar' : 'aboveBar',
        shape: call ? 'arrowUp' : 'arrowDown',
        color: s.skipped ? cssVar('--muted') : call ? up : down,
        size: on ? 2 : 1,
        text: `${codeOf(s.technique)}${on ? ' ◀' : ''}`,
      };
    });
    const s = signals.find((x) => x.id === selected);
    if (s) {
      const line = (price, color, title, style = LineStyle.Dashed) => live.current.lines.push(series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
      line(s.entry, accent, 'Entry');
      line(s.stop, down, 'Stop');
      if (s.target?.reason === 'TARGET') line(s.target.exitSpot, up, 'Book profit', LineStyle.Dotted);
      for (const [o, name] of [[s.lock, 'Lock'], [s.target, 'Target']]) {
        if (!o) continue;
        shaped.push({ time: barAt(times, toChartTime(o.exitTime)), position: s.side === 'CE' ? 'aboveBar' : 'belowBar', shape: 'circle', color: o.net >= 0 ? up : down, text: `${name} ${formatPnl(Math.round(o.net))}` });
      }
    }
    // two exits on one bar would sit on each other: keep their order stable
    markers.setMarkers(shaped.sort((a, b) => a.time - b.time));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals, selected, candles, theme]);

  if (!candles?.length) {
    return <div style={{ height: height / 2 }} className="flex items-center justify-center rounded-xl bg-surface-2 px-6 text-center text-xs text-muted">No Nifty minute chart for this day. The broker keeps only the last few sessions.</div>;
  }
  return <div ref={ref} style={{ height }} className="w-full" />;
}
