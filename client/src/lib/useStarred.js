import { useCallback, useState } from 'react';

const KEY = 'npt_starred';
const read = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || '[]'));
  } catch {
    return new Set();
  }
};

/** Starred stocks, remembered on this device. */
export function useStarred() {
  const [starred, setStarred] = useState(read);
  const toggle = useCallback((symbol) => {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      try {
        localStorage.setItem(KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return { starred, toggle };
}
