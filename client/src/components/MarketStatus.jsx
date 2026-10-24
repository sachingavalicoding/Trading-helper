import { useMarket } from '../context/MarketContext.jsx';
import { Badge } from './ui.jsx';

const PHASE_LABEL = { OPEN: 'Market open', PRE_OPEN: 'Pre-open', CLOSED: 'Closed', WEEKEND: 'Weekend', HOLIDAY: 'Holiday' };

export function MarketStatus({ compact = false }) {
  const { status, connected } = useMarket();
  if (!status) return null;
  const open = status.market.isOpen;
  return (
    <div className="flex items-center gap-1.5">
      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-muted" title={`NSE ${status.market.opensAt} – ${status.market.closesAt}`}>
        <span className={`h-2 w-2 rounded-full ${open ? 'bg-up' : 'bg-down'}`} />
        {!compact && (PHASE_LABEL[status.market.phase] || status.market.phase)}
      </span>
      {status.feed.simulated && <Badge tone="warn">Simulated</Badge>}
      {(!connected || !status.feed.connected) && <Badge tone="down">Feed offline</Badge>}
    </div>
  );
}
