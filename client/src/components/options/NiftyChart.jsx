import { useEffect, useMemo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { CandleChart } from '../CandleChart.jsx';
import { useApi } from '../../lib/useApi.js';
import { useTick } from '../../lib/tickStore.js';
import { formatPct, formatPrice, pnlClass } from '../../lib/format.js';
import { Card, Flash } from '../ui.jsx';

const SHOWN_KEY = 'npt_nifty_chart';
const readShown = () => {
  try {
    return localStorage.getItem(SHOWN_KEY) !== 'off';
  } catch {
    return true;
  }
};

/**
 * The Nifty 50 chart that every option trade is read from. Dashed lines mark the chart stop a Call (CE)
 * or a Put (PE) would use, so you can see where the trade is wrong before you buy it.
 */
export function NiftyChart() {
  const tick = useTick('NIFTY 50');
  const [shown, setShown] = useState(readShown);
  const { data, reload } = useApi('/options/read', []);

  useEffect(() => {
    const t = setInterval(reload, 30000);
    return () => clearInterval(t);
  }, [reload]);

  const lines = useMemo(() => {
    if (!data?.ready) return [];
    const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    return [
      { price: data.ce?.stop?.price, color: css('--up'), title: 'CE stop' },
      { price: data.pe?.stop?.price, color: css('--down'), title: 'PE stop' },
    ].filter((l) => l.price);
  }, [data]);

  function toggle() {
    setShown((v) => {
      try {
        localStorage.setItem(SHOWN_KEY, v ? 'off' : 'on');
      } catch {
        /* ignore */
      }
      return !v;
    });
  }

  return (
    <Card className="overflow-hidden p-3">
      <button type="button" onClick={toggle} aria-expanded={shown} className="flex w-full items-center justify-between gap-2 text-left">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-accent2">Nifty 50 chart</div>
          <Flash value={tick?.ltp} dir={tick?.dir} className="num text-xl font-bold">
            {formatPrice(tick?.ltp)}
          </Flash>
          <span className={`num ml-2 text-xs font-semibold ${pnlClass(tick?.change)}`}>{formatPct(tick?.changePct)}</span>
        </div>
        <div className="num flex items-center gap-3 text-[11px] text-muted">
          <span>
            H <b className="text-fg">{formatPrice(tick?.high)}</b>
          </span>
          <span>
            L <b className="text-fg">{formatPrice(tick?.low)}</b>
          </span>
          <ChevronDown className={`h-4 w-4 transition-transform ${shown ? 'rotate-180' : ''}`} />
        </div>
      </button>
      {shown && (
        <div className="mt-2">
          <CandleChart symbol="NIFTY 50" isIndex lines={lines} />
        </div>
      )}
    </Card>
  );
}
