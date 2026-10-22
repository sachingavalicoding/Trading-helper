import test from 'node:test';
import assert from 'node:assert/strict';
import { getMarketStatus, istParts } from '../src/market/marketHours.js';

// 2026-10-21 is a Wednesday. IST = UTC + 5:30.
const at = (utc) => new Date(utc);

test('converts to IST wall clock', () => {
  const p = istParts(at('2026-10-21T03:45:00Z'));
  assert.equal(p.dateKey, '2026-10-21');
  assert.equal(p.minutes, 9 * 60 + 15);
});

test('open between 09:15 and 15:30 IST on a weekday', () => {
  assert.equal(getMarketStatus(at('2026-10-21T03:44:59Z')).phase, 'PRE_OPEN');
  assert.equal(getMarketStatus(at('2026-10-21T03:45:00Z')).isOpen, true);
  assert.equal(getMarketStatus(at('2026-10-21T09:59:59Z')).isOpen, true);
  assert.equal(getMarketStatus(at('2026-10-21T10:00:00Z')).phase, 'CLOSED');
});

test('square-off flag from 15:15 IST', () => {
  assert.equal(getMarketStatus(at('2026-10-21T09:44:00Z')).afterSquareOff, false);
  assert.equal(getMarketStatus(at('2026-10-21T09:45:00Z')).afterSquareOff, true);
});

test('weekends and configured holidays are closed', () => {
  assert.equal(getMarketStatus(at('2026-10-24T05:00:00Z')).phase, 'WEEKEND'); // Saturday
  const s = getMarketStatus(at('2026-10-21T05:00:00Z'), ['2026-10-21']);
  assert.equal(s.phase, 'HOLIDAY');
  assert.equal(s.isOpen, false);
});

test('IST date rolls over at 18:30 UTC', () => {
  assert.equal(istParts(at('2026-10-21T18:29:00Z')).dateKey, '2026-10-21');
  assert.equal(istParts(at('2026-10-21T18:30:00Z')).dateKey, '2026-10-22');
});
