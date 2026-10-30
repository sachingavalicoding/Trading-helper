// The two indexes whose options are traded. `symbol` is the name the market feed and the charts use.
export const INDEXES = [
  { key: 'NIFTY', symbol: 'NIFTY 50', name: 'Nifty 50', short: 'Nifty' },
  { key: 'SENSEX', symbol: 'SENSEX', name: 'Sensex', short: 'Sensex' },
];

const KEY = 'npt_options_index';

export const indexOf = (key) => INDEXES.find((i) => i.key === key) ?? INDEXES[0];

/** The index you looked at last, Nifty at first. */
export function loadIndex() {
  try {
    const v = localStorage.getItem(KEY);
    if (INDEXES.some((i) => i.key === v)) return v;
  } catch {
    /* nothing remembered */
  }
  return INDEXES[0].key;
}

export function saveIndex(key) {
  try {
    localStorage.setItem(KEY, key);
  } catch {
    /* the choice is simply not remembered */
  }
}

/** Index options need both indexes' names in plain words: "Nifty" or "Nifty and Sensex". */
export const indexWords = (keys) => keys.map((k) => indexOf(k).short).join(' and ');
