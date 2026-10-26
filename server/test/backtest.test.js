import { test } from 'node:test';
import assert from 'node:assert/strict';
import { netResult, evaluate } from '../src/scanner/backtest.js';

const idea = (over) => ({ side: 'BUY', entry: 100, stopLoss: 99, target1: 102, exitPrice: 102, status: 'TARGET_HIT', openedAt: '2026-10-20T04:00:00Z', ...over });

test('a target hit nets profit after charges, sized so the stop loses about the risk amount', () => {
  const r = netResult(idea(), { riskAmount: 1000, slippagePct: 0.05 });
  assert.ok(r.qty > 800 && r.qty <= 1000);
  assert.ok(r.gross > 0 && r.charges > 0 && r.net < r.gross);
});

test('a stop-out loses roughly the risk amount plus charges and slippage', () => {
  const r = netResult(idea({ status: 'STOPPED', exitPrice: 99 }), { riskAmount: 1000, slippagePct: 0.05 });
  assert.ok(r.net < -1000 && r.net > -1400);
});

test('a short idea profits when price falls', () => {
  const r = netResult(idea({ side: 'SELL', stopLoss: 101, exitPrice: 98 }), { riskAmount: 1000 });
  assert.ok(r.net > 0);
});

test('an idea with no stop distance or too small to size is skipped, never invented', () => {
  assert.equal(netResult(idea({ stopLoss: 100 }), { slippagePct: 0 }), null);
  assert.equal(netResult(idea({ entry: 5000, stopLoss: 1 }), { riskAmount: 1000 }), null);
});

test('evaluate reports expectancy, profit factor and the worst drop in order of time', () => {
  const win = (t) => idea({ openedAt: t });
  const loss = (t) => idea({ status: 'STOPPED', exitPrice: 99, openedAt: t });
  const e = evaluate([loss('2026-10-20T06:00:00Z'), win('2026-10-20T04:00:00Z'), loss('2026-10-20T05:00:00Z')], { riskAmount: 1000 });
  assert.equal(e.trades, 3);
  assert.equal(e.winRate, 33);
  assert.ok(e.profitFactor < 1 && e.maxDrawdown > 2000 && e.totalNet < 0);
  assert.equal(evaluate([]).trades, 0);
});
