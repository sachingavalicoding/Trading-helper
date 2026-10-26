import { useEffect, useState } from 'react';
import { api } from './api.js';
import { formatInt } from './format.js';

let cached = null;

/** The virtual starting wallet, as the server is configured (STARTING_BALANCE), so screens never hardcode it. */
export function useStartingBalance() {
  const [value, setValue] = useState(cached);
  useEffect(() => {
    if (cached != null) return;
    api('/health')
      .then((h) => {
        if (Number.isFinite(h.startingBalance)) {
          cached = h.startingBalance;
          setValue(cached);
        }
      })
      .catch(() => {});
  }, []);
  return { startingBalance: value, label: value == null ? 'virtual money' : `₹${formatInt(value)}` };
}
