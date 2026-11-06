import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ScannerService } from '../src/scanner/service.js';

test('an idea price ran away from or slid against no longer takes one of the five open-idea places', () => {
  const prices = { ITC: 404, WIPRO: 197.5, LT: 401, TCS: 1000 };
  const market = Object.assign(new EventEmitter(), { getTick: (s) => (prices[s] == null ? null : { ltp: prices[s] }) });
  const scanner = new ScannerService({ market, config: {} });
  const idea = (symbol, entry, stopLoss, side = 'BUY') => ({ symbol, entry, stopLoss, side });
  scanner.open.set('ITC', [idea('ITC', 400, 395)]); // ran 0.8R: too late to enter
  scanner.open.set('WIPRO', [idea('WIPRO', 200, 195)]); // slid 0.5R towards the stop
  scanner.open.set('LT', [idea('LT', 400, 395)]); // 0.2R: still enterable
  scanner.open.set('TCS', [idea('TCS', 1001, 1006, 'SELL')]); // a short 0.2R in its favour: still enterable
  scanner.open.set('SBIN', [idea('SBIN', 800, 795)]); // no price yet: keeps its place
  assert.equal(scanner.enterableCount(), 3);
  prices.ITC = 401; // came back into the entry zone
  assert.equal(scanner.enterableCount(), 4);
});
