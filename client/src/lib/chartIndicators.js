import { LineSeries, HistogramSeries, LineStyle } from 'lightweight-charts';
import { sma, ema, bollinger, rsi, macd } from './indicators.js';
import { computeVwap } from './chart.js';

// What the indicator picker offers. `pane: true` ones get their own pane below the price chart.
export const INDICATORS = [
  { id: 'volume', label: 'Volume', color: '#64748b', needsVolume: true },
  { id: 'vwap', label: 'VWAP', color: '#f59e0b', needsVolume: true },
  { id: 'ema9', label: 'EMA 9', color: '#38bdf8' },
  { id: 'ema21', label: 'EMA 21', color: '#a78bfa' },
  { id: 'sma50', label: 'SMA 50', color: '#2dd4bf' },
  { id: 'bb', label: 'Bollinger Bands (20, 2)', color: '#94a3b8' },
  { id: 'rsi', label: 'RSI (14)', color: '#c084fc', pane: true },
  { id: 'macd', label: 'MACD (12, 26, 9)', color: '#38bdf8', pane: true },
];
export const DEFAULT_INDICATORS = ['volume', 'vwap'];

const line = (color, extra = {}) => ({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });
const alpha = (hex, a) => {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

/**
 * Adds the series for one indicator to `chart` and returns
 * [{ series, compute(candles) -> points }]. Callers setData/update with compute's output.
 */
export function addIndicator(chart, id, { up, down, paneIndex }) {
  const def = INDICATORS.find((i) => i.id === id);
  switch (id) {
    case 'volume': {
      const s = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
      return [{ series: s, compute: (c) => c.map((b) => ({ time: b.time, value: b.volume, color: alpha(b.close >= b.open ? up : down, 0.45) })) }];
    }
    case 'vwap':
      return [{ series: chart.addSeries(LineSeries, line(def.color, { lineWidth: 2 })), compute: computeVwap }];
    case 'ema9':
      return [{ series: chart.addSeries(LineSeries, line(def.color)), compute: (c) => ema(c, 9) }];
    case 'ema21':
      return [{ series: chart.addSeries(LineSeries, line(def.color)), compute: (c) => ema(c, 21) }];
    case 'sma50':
      return [{ series: chart.addSeries(LineSeries, line(def.color)), compute: (c) => sma(c, 50) }];
    case 'bb': {
      const opts = line(def.color, { lineWidth: 1 });
      return [
        { series: chart.addSeries(LineSeries, opts), compute: (c) => bollinger(c).upper },
        { series: chart.addSeries(LineSeries, { ...opts, lineStyle: LineStyle.Dotted }), compute: (c) => bollinger(c).middle },
        { series: chart.addSeries(LineSeries, opts), compute: (c) => bollinger(c).lower },
      ];
    }
    case 'rsi': {
      const s = chart.addSeries(LineSeries, line(def.color, { lastValueVisible: true }), paneIndex);
      s.createPriceLine({ price: 70, color: alpha(down, 0.6), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      s.createPriceLine({ price: 30, color: alpha(up, 0.6), lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      return [{ series: s, compute: (c) => rsi(c, 14) }];
    }
    case 'macd': {
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIndex);
      const m = chart.addSeries(LineSeries, line('#38bdf8', { lastValueVisible: true }), paneIndex);
      const sig = chart.addSeries(LineSeries, line('#f97316'), paneIndex);
      return [
        { series: hist, compute: (c) => macd(c).histogram.map((p) => ({ ...p, color: alpha(p.value >= 0 ? up : down, 0.6) })) },
        { series: m, compute: (c) => macd(c).line },
        { series: sig, compute: (c) => macd(c).signal },
      ];
    }
    default:
      return [];
  }
}
