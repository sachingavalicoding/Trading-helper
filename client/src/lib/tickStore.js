import { useEffect, useState, useSyncExternalStore } from 'react';

// Per-symbol tick store. Components subscribe to one symbol, so a tick for RELIANCE
// re-renders only the RELIANCE row instead of the whole watchlist.
const ticks = new Map();
const listeners = new Map();
const anyListeners = new Set();

export function setTick(tick) {
  const prev = ticks.get(tick.symbol);
  const dir = prev && tick.ltp !== prev.ltp ? (tick.ltp > prev.ltp ? 'up' : 'down') : prev?.dir;
  // Lite ticks omit depth; keep the last depth we saw.
  const next = { ...prev, ...tick, depth: tick.depth ?? prev?.depth ?? null, dir, prevLtp: prev?.ltp };
  ticks.set(tick.symbol, next);
  listeners.get(tick.symbol)?.forEach((fn) => fn());
  anyListeners.forEach((fn) => fn(next));
}

export const getTick = (symbol) => ticks.get(symbol);
export const getLtp = (symbol) => ticks.get(symbol)?.ltp;

export function subscribeTick(symbol, fn) {
  if (!listeners.has(symbol)) listeners.set(symbol, new Set());
  listeners.get(symbol).add(fn);
  return () => listeners.get(symbol)?.delete(fn);
}

export function subscribeAll(fn) {
  anyListeners.add(fn);
  return () => anyListeners.delete(fn);
}

export function useTick(symbol) {
  return useSyncExternalStore(
    (fn) => subscribeTick(symbol, fn),
    () => ticks.get(symbol),
  );
}

export function clearTicks() {
  ticks.clear();
}

/** Re-render when any of `symbols` ticks; returns a getter for their latest LTPs. */
export function useLtps(symbols) {
  const key = symbols.join('|');
  const [, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    const bump = () => {
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        setN((n) => n + 1);
      });
    };
    const unsubs = key ? key.split('|').map((s) => subscribeTick(s, bump)) : [];
    return () => {
      cancelAnimationFrame(raf);
      unsubs.forEach((u) => u());
    };
  }, [key]);
  return (symbol) => ticks.get(symbol)?.ltp;
}
