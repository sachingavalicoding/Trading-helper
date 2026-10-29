import { useMemo } from 'react';
import { LineStyle } from 'lightweight-charts';
import { codeOf } from '../lib/patternReview.js';
import { formatPnl } from '../lib/format.js';
import { useTheme } from '../context/ThemeContext.jsx';
import { DayChart } from './DayChart.jsx';

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/**
 * The Nifty day as candles with an arrow where each watched pattern formed (up for a call, down for a put), on the full chart with indicators.
 * Tap an arrow, or pick the row below, and the chart also draws that trade: the entry, the stop, the level where a profit
 * target would have been hit, and where the profit lock and the target sold.
 * `signals`: the watched ones. `selected`: one of them or null. `onPick(id)`.
 */
export function PatternChart({ candles, warm, minutes, signals, selected, onPick, height = 320 }) {
  const { theme } = useTheme();
  const { markers, lines } = useMemo(() => {
    const up = cssVar('--up');
    const down = cssVar('--down');
    const markers = signals.map((s) => {
      const call = s.side === 'CE';
      return { id: s.id, time: s.time - 300, position: call ? 'belowBar' : 'aboveBar', shape: call ? 'arrowUp' : 'arrowDown', color: s.skipped ? cssVar('--muted') : call ? up : down, size: s.id === selected ? 2 : 1, text: `${codeOf(s.technique)}${s.id === selected ? ' ◀' : ''}` };
    });
    const lines = [];
    const s = signals.find((x) => x.id === selected);
    if (s) {
      lines.push({ price: s.entry, color: cssVar('--accent'), title: 'Entry' }, { price: s.stop, color: down, title: 'Stop' });
      if (s.target?.reason === 'TARGET') lines.push({ price: s.target.exitSpot, color: up, title: 'Book profit', style: LineStyle.Dotted });
      for (const [o, name] of [[s.lock, 'Lock'], [s.target, 'Target']]) {
        if (o) markers.push({ id: `${s.id}:${name}`, time: o.exitTime, position: s.side === 'CE' ? 'aboveBar' : 'belowBar', shape: 'circle', color: o.net >= 0 ? up : down, text: `${name} ${formatPnl(Math.round(o.net))}` });
      }
    }
    return { markers, lines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals, selected, theme]);
  return <DayChart candles={candles} warm={warm} minutes={minutes} isIndex markers={markers} lines={lines} height={height} onPick={(ids) => onPick(ids.find((id) => signals.some((s) => s.id === id)) ?? ids[0])} />;
}
