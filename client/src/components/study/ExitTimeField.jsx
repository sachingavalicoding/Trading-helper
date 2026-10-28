import { useState } from 'react';
import { useApi } from '../../lib/useApi.js';
import { DEFAULT_EXIT_MIN, minOfTime, timeText } from '../../lib/ladder.js';

/**
 * The time a study closes every trade. It starts at the exit time saved in Account Limits for `segment` ('shares' or 'options'),
 * and typing another one tries it for this run only. `exitMin` is null while the box holds something that is not a time from 09:30 to 15:15.
 */
export function useExitTime(segment) {
  const { data } = useApi('/trade-defaults', []);
  const [typed, setTyped] = useState(null);
  const text = typed ?? timeText(data?.[segment]?.exitMin ?? DEFAULT_EXIT_MIN);
  return { text, setText: setTyped, exitMin: minOfTime(text) };
}

export function ExitTimeField({ time }) {
  return (
    <div className="space-y-1">
      <label className="flex items-center justify-between gap-3 text-xs text-muted">
        <span>Close every trade at (IST). Try 14:15 to see if closing earlier pays.</span>
        <input type="time" min="09:30" max="15:15" className="field num !w-28 !px-2 !py-1.5 text-right !text-sm" value={time.text} onChange={(e) => time.setText(e.target.value)} aria-label="Time to close every trade" />
      </label>
      {time.exitMin == null && <p className="text-xs text-down">Enter a time from 09:30 to 15:15.</p>}
    </div>
  );
}
