/**
 * Rank stocks by how far they are from Nifty 50 today. `ticks` is [{ symbol, changePct }].
 * Weakest first means the stocks falling most against the index: the places to look for sells.
 */
export function rankMovers(ticks, niftyChangePct, count = 5) {
  const rows = ticks
    .filter((t) => t && Number.isFinite(t.changePct))
    .map((t) => ({ symbol: t.symbol, changePct: t.changePct, vsNifty: t.changePct - (niftyChangePct || 0) }));
  const byWeak = [...rows].sort((a, b) => a.vsNifty - b.vsNifty);
  return { weakest: byWeak.slice(0, count), strongest: byWeak.slice(-count).reverse() };
}
