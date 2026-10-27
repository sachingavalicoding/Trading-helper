import { useEffect, useState } from 'react';
import { useMarket } from '../context/MarketContext.jsx';

const OPEN_MIN = 9 * 60 + 15;
const SQUARE_OFF_MIN = 15 * 60 + 15;
const CLOSE_MIN = 15 * 60 + 30;

const istMinutes = (now) => {
  const d = new Date(now.getTime() + 330 * 60000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

/**
 * Why a new trade cannot be placed right now, or null when it can. Mirrors the order engine's
 * rules (market closed, or after the 15:15 square-off) so the Buy button can say so before you tap.
 * The clock is read here as well as from the server status, which only refreshes every 30 seconds.
 */
export function orderBlock(market, now = new Date()) {
  if (!market || !market.enforced) return null; // practice mode on the simulated feed: any time
  if (!market.tradingDay) return market.phase === 'HOLIDAY' ? 'NSE holiday: market closed' : 'Weekend: market closed';
  const m = istMinutes(now);
  if (m < OPEN_MIN) return 'Market opens at 09:15';
  if (m >= CLOSE_MIN) return 'Market closed (opens 09:15 tomorrow)';
  if (m >= SQUARE_OFF_MIN) return 'No new trades after the 15:15 square-off';
  return null;
}

/** Re-checks every 15 seconds so a button turns off at 15:15 without a reload. */
export function useOrderBlock() {
  const { status } = useMarket();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);
  return orderBlock(status?.market, now);
}
