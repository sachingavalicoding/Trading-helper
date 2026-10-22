import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCharges } from '../src/services/charges.js';

test('buy of ₹1,00,000: brokerage capped at ₹20, stamp duty, no STT', () => {
  const c = calculateCharges({ side: 'BUY', qty: 100, price: 1000 });
  assert.equal(c.brokerage, 20);
  assert.equal(c.stt, 0);
  assert.equal(c.stamp, 3);
  assert.equal(c.exchange, 2.97);
  assert.equal(c.sebi, 0.1);
  assert.equal(c.gst, 4.15); // 18% of (20 + 2.97 + 0.1)
  assert.equal(c.total, 30.22);
});

test('sell of ₹1,00,000: STT 0.025%, no stamp duty', () => {
  const c = calculateCharges({ side: 'SELL', qty: 100, price: 1000 });
  assert.equal(c.stt, 25);
  assert.equal(c.stamp, 0);
  assert.equal(c.total, 52.22);
});

test('small order: brokerage is 0.03% when under the cap', () => {
  const c = calculateCharges({ side: 'BUY', qty: 10, price: 500 });
  assert.equal(c.brokerage, 1.5);
});
