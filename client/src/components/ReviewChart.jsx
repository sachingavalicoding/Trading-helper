import { useMemo } from 'react';
import { LineStyle } from 'lightweight-charts';
import { useTheme } from '../context/ThemeContext.jsx';
import { DayChart } from './DayChart.jsx';

const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/**
 * One finished (or running) day as candles on the full chart (timeframes, indicators, fullscreen), with the open and previous close
 * drawn across it and a marker where each headline, scanner idea or trade of yours came in.
 * `marks`: [{ at, text, kind: 'news-up' | 'news-down' | 'buy' | 'sell' }]. `isIndex`: Nifty has no volume.
 */
export function ReviewChart({ candles, warm, minutes, open, prevClose, marks = [], isIndex = false, height = 300 }) {
  const { theme } = useTheme();
  const { markers, lines } = useMemo(() => {
    const up = cssVar('--up');
    const down = cssVar('--down');
    const markers = marks.map((m, i) => {
      const bearish = m.kind === 'news-down' || m.kind === 'sell';
      return { id: String(i), time: new Date(m.at).getTime() / 1000, position: bearish ? 'aboveBar' : 'belowBar', shape: bearish ? 'arrowDown' : 'arrowUp', color: m.kind.startsWith('news') ? cssVar('--accent2') : m.kind === 'buy' ? up : down, text: m.text };
    });
    const lines = [];
    if (open) lines.push({ price: open, color: cssVar('--accent2'), title: 'Open' });
    if (prevClose) lines.push({ price: prevClose, color: cssVar('--muted'), title: 'Prev close', style: LineStyle.Dotted });
    return { markers, lines };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, open, prevClose, theme]);
  return <DayChart candles={candles} warm={warm} minutes={minutes} isIndex={isIndex} markers={markers} lines={lines} height={height} />;
}
