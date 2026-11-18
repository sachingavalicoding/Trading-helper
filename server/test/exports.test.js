import test from 'node:test';
import assert from 'node:assert/strict';
import { tradesCsv, daysCsv } from '../src/report/pnlCsv.js';
import { guideText } from '../src/guide/guide.js';
import { CONDITIONS } from '../src/combos/conditions.js';

const closed = (over) => ({ tradingDay: '2026-11-02', openedAt: new Date('2026-11-02T03:51:00Z'), closedAt: new Date('2026-11-02T04:13:00Z'), symbol: 'NIFTY-3NOV-23250-CE', segment: 'OPT', direction: 'LONG', buyQty: 130, sellQty: 130, buyValue: 13773.5, sellValue: 17199, realizedPnl: 3425.5, charges: 86.5, ...over });

test('the profit and loss CSV has one row per closed trade with net after charges, and a total row', () => {
  const csv = tradesCsv([closed(), closed({ symbol: 'ONGC', segment: 'EQ', buyQty: 436, sellQty: 436, buyValue: 99774, sellValue: 100106, realizedPnl: 332, charges: 83 })]);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 4, 'header, 2 trades, total');
  assert.match(lines[0], /^Day,Opened \(IST\),Closed \(IST\),Symbol,Segment/);
  assert.match(lines[1], /^2026-11-02,2026-11-02 09:21:00,2026-11-02 09:43:00,NIFTY-3NOV-23250-CE,Options,Buy first,130,105.95,132.3,3425.5,86.5,3339$/);
  assert.match(lines[3], /^Total,.*3757\.5,169\.5,3588$/);
});

test('the daily CSV groups by day, counts wins and losses and keeps a running total', () => {
  const csv = daysCsv([closed(), closed({ realizedPnl: -2700, charges: 115 }), closed({ tradingDay: '2026-11-03', realizedPnl: 100, charges: 10 })]);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], '2026-11-02,2,1,1,725.5,201.5,524,524');
  assert.equal(lines[2], '2026-11-03,1,1,0,100,10,90,614');
});

test('a cell with a comma or quote is quoted, and an empty list gives only the header and a zero total', () => {
  assert.match(tradesCsv([closed({ symbol: 'A,"B"' })]), /"A,""B"""/);
  assert.equal(tradesCsv([]).trim().split('\n').length, 2);
});

test('the guide lists every check of the app, so it never drifts, and covers the main how-tos', () => {
  const g = guideText();
  for (const c of CONDITIONS) assert.ok(g.includes(`**${c.label}**`), c.label);
  for (const h of ['## 5. Studies', '## 6. Making a combination', 'View button', 'Trades > P&L', 'Open drive']) assert.ok(g.includes(h), h);
});

test('the P&L summary groups trades by day, week and month, keeps a running total and finds the worst drawdown', async () => {
  const { pnlSummary } = await import('../src/report/pnlSummary.js');
  const s = pnlSummary([
    closed({ tradingDay: '2026-10-29', closedAt: new Date('2026-10-29T05:00:00Z'), openedAt: new Date('2026-10-29T04:00:00Z'), realizedPnl: 1000, charges: 0 }),
    closed({ tradingDay: '2026-10-30', closedAt: new Date('2026-10-30T05:00:00Z'), openedAt: new Date('2026-10-30T04:00:00Z'), realizedPnl: -1500, charges: 0 }),
    closed({ tradingDay: '2026-11-02', closedAt: new Date('2026-11-02T05:00:00Z'), realizedPnl: 400, charges: 0 }),
  ]);
  assert.equal(s.totals.net, -100);
  assert.equal(s.totals.winRate, 67);
  assert.equal(s.totals.maxDrawdown, 1500);
  assert.deepEqual(s.cumulative.map((c) => c.total), [1000, -500, -100]);
  assert.equal(s.periods.day.length, 3);
  assert.equal(s.periods.week.length, 2, '29-30 Oct and 2 Nov are different weeks');
  assert.equal(s.periods.month.length, 2);
  assert.equal(s.periods.month[0].label, 'Oct 2026');
  assert.equal(s.byWeekday.find((w) => w.label === 'Thu').net, 1000);
  assert.equal(pnlSummary([]).totals.trades, 0);
});

test('the picture guide has every screenshot it lists, and the built HTML and PDF are saved next to the text', async () => {
  const { existsSync, statSync } = await import('node:fs');
  const { FIGURES } = await import('../src/guide/figures.js');
  const { guideHtml } = await import('../scripts/build-guide.mjs');
  const dir = new URL('../src/guide/', import.meta.url);
  const files = Object.values(FIGURES).flat();
  assert.ok(files.length >= 14);
  for (const f of files) assert.ok(existsSync(new URL(`shots/${f.file}.jpg`, dir)), f.file);
  const html = guideHtml();
  assert.equal(html.match(/<figure /g).length, files.length, 'one picture per listed figure');
  assert.match(html, /made-up demo data/);
  assert.ok(statSync(new URL('app-guide.pdf', dir)).size > 100000);
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(new URL('app-guide.html', dir), 'utf8'), html, 'app-guide.html is out of date: run node scripts/build-guide.mjs --pdf');
});
