import { useEffect, useState } from 'react';

// Where Study reads its candles: the saved data (as always) or the year files (Research > Saved data), 1 or 2 years. Kept on this phone.
const KEY = 'studySource';
const read = () => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (v?.source === 'year' && (v.years === 1 || v.years === 2)) return v;
  } catch {
    /* ignore */
  }
  return { source: 'saved', years: 1 };
};
const listeners = new Set();

export const studySource = () => read();

export function setStudySource(v) {
  localStorage.setItem(KEY, JSON.stringify(v));
  listeners.forEach((f) => f(v));
}

export function useStudySource() {
  const [v, setV] = useState(read);
  useEffect(() => {
    listeners.add(setV);
    return () => listeners.delete(setV);
  }, []);
  return [v, setStudySource];
}
