import { useEffect, useRef } from 'react';
import { createChart, AreaSeries, HistogramSeries, ColorType } from 'lightweight-charts';
import { useTheme } from '../context/ThemeContext.jsx';

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** kind 'area' for the equity curve, 'histogram' for daily P&L (green/red bars). */
export function MiniChart({ kind, data, height = 220 }) {
  const ref = useRef(null);
  const { theme } = useTheme();

  useEffect(() => {
    if (!ref.current) return undefined;
    const border = cssVar('--border');
    const chart = createChart(ref.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted'), fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: border } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: kind === 'area' },
      handleScroll: false,
      handleScale: false,
    });
    if (kind === 'area') {
      const accent = cssVar('--accent');
      const s = chart.addSeries(AreaSeries, { lineColor: accent, topColor: `${accent}55`, bottomColor: `${accent}05`, lineWidth: 2, priceLineVisible: false });
      s.setData(data);
    } else {
      const up = cssVar('--up');
      const down = cssVar('--down');
      const s = chart.addSeries(HistogramSeries, { priceLineVisible: false });
      s.setData(data.map((d) => ({ ...d, color: d.value >= 0 ? up : down })));
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [kind, data, theme]);

  return <div ref={ref} style={{ height }} className="w-full" />;
}
