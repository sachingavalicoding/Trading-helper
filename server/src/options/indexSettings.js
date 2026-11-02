// The Sensex can have a setup of its own (Account > Limits > Sensex). `forIndex` gives the options settings as one index sees them:
// for the Nifty, or for the Sensex while its own setup is off, they come back unchanged; for the Sensex with its own setup on, the
// Sensex values replace the Nifty ones, and any Sensex value left unset keeps the Nifty one.

const pick = (own, base) => (own === undefined || own === null ? base : own);

export const SENSEX_KEYS = ['sensexTrailMode', 'sensexTrailPoints', 'sensexTrailStart', 'sensexBreakEven', 'sensexEntryFrom', 'sensexEntryTo', 'sensexMaxLots', 'sensexPatterns', 'sensexSide'];

export function forIndex(settings, index) {
  if (!settings || index !== 'SENSEX' || settings.sensexOwn !== true) return settings;
  const s = settings;
  return {
    ...s,
    trailMode: pick(s.sensexTrailMode, s.trailMode),
    trailPoints: pick(s.sensexTrailPoints, s.trailPoints),
    trailStart: pick(s.sensexTrailStart, s.trailStart),
    breakEvenPoints: pick(s.sensexBreakEven, s.breakEvenPoints),
    entryFrom: pick(s.sensexEntryFrom, s.entryFrom),
    entryTo: pick(s.sensexEntryTo, s.entryTo),
    maxLots: pick(s.sensexMaxLots, s.maxLots),
    patterns: pick(s.sensexPatterns, s.patterns),
    sideOnly: s.sensexSide === 'CE' || s.sensexSide === 'PE' ? s.sensexSide : null, // calls only / puts only
  };
}
