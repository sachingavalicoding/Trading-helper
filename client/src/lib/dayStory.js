import { formatPrice } from './format.js';

/** What kind of day it was, from how much of the range the close kept: trend, range or in between. */
export function dayType(story) {
  if (!story || !story.rangePts) return null;
  const share = Math.abs(story.changePts) / story.rangePts;
  const dir = story.changePts >= 0 ? 'up' : 'down';
  if (share >= 0.6) return { key: `trend-${dir}`, label: `Trend day ${dir}`, hint: `It closed near its ${dir === 'up' ? 'high' : 'low'}. Buying ${dir === 'up' ? 'calls' : 'puts'} early and holding paid; the other side kept losing.` };
  if (share <= 0.25) return { key: 'range', label: 'Range day', hint: 'It went up and down and ended near where it began. Breakouts fail on days like this, and option buyers lose to time decay.' };
  return { key: `mixed-${dir}`, label: `Mixed day, leaning ${dir}`, hint: 'There was a move, but a big part of it was given back.' };
}

const sign = (n) => `${n > 0 ? '+' : ''}${Math.round(n)}`;

/** The day in plain sentences: where it opened, high and low, closed, and each swing with the option side that was right in it. */
export function storyLines(story, clock) {
  if (!story) return [];
  const head = `Opened ${formatPrice(story.open)}, high ${formatPrice(story.high.price)} at ${clock(story.high.time)}, low ${formatPrice(story.low.price)} at ${clock(story.low.time)}, closed ${formatPrice(story.close)}: ${sign(story.changePts)} points on a ${Math.round(story.rangePts)} point range.`;
  const legs = (story.legs || []).map((l) => {
    const up = l.dir === 'up';
    return `${clock(l.from)} to ${clock(l.to)}: ${up ? 'up' : 'down'} ${Math.round(l.pts)} points (${formatPrice(l.fromPrice)} to ${formatPrice(l.toPrice)}). ${up ? 'A call (CE)' : 'A put (PE)'} was the right side; an at-the-money option gains very roughly half of that, about ${Math.round(l.pts / 2)} points.`;
  });
  return [head, ...legs];
}

/** The same swings as a count, for the summary line: "3 swings, 2 up and 1 down". */
export function legCount(story) {
  const legs = story?.legs ?? [];
  const up = legs.filter((l) => l.dir === 'up').length;
  return { total: legs.length, up, down: legs.length - up };
}
