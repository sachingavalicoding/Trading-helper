// Words for the share score study (components/study/ScoreStudy.jsx).

/** One sentence on whether higher scores did better, from the score bands (bands with fewer than 5 ideas are ignored). */
export function scoreVerdict(s) {
  const bands = (s?.bands?.now ?? []).filter((b) => b.trades >= 5 && b.avgNet != null);
  if (bands.length < 2) return 'Too few ideas in each score band to say whether a higher score does better. Run a longer study (10 or 15 days).';
  const low = bands[0];
  const high = bands.at(-1);
  const rising = bands.every((b, i) => i === 0 || b.avgNet >= bands[i - 1].avgNet - 50);
  if (high.avgNet > low.avgNet && rising) return `Yes: ideas scoring ${high.band} averaged ${Math.round(high.avgNet)} against ${Math.round(low.avgNet)} for ${low.band}, and the average rises with the score. A higher minimum score should help.`;
  if (high.avgNet > low.avgNet) return `Partly: ${high.band} averaged ${Math.round(high.avgNet)} against ${Math.round(low.avgNet)} for ${low.band}, but not step by step. Look at which parts help below.`;
  return `No: ideas scoring ${high.band} averaged ${Math.round(high.avgNet)}, no better than ${Math.round(low.avgNet)} for ${low.band}. The score is not picking winners on these days; the parts below show which indicators do.`;
}
