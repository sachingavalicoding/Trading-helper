import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { OptionTrader } from '../src/options/optionTrader.js';
import { createApp } from '../src/app.js';
import { setup, teardown, closeDb, registerUser } from './helpers.js';
import { TradeDefaults } from '../src/models/index.js';
import { rulesFor } from '../src/models/TradeDefaults.js';
import { stopRuleOf } from '../src/study/patterns.js';
import { entryWindowOf, entryTest, entryTestOf } from '../src/options/signal.js';
import { normalizeCombos, comboFitsIndex } from '../src/combos/combos.js';
import { studyCombos } from '../src/study/optionsStudy.js';

let ctx;
let user;
const api = () => request(ctx.app);
beforeEach(async () => {
  ctx = await setup();
  const optionTrader = new OptionTrader({ market: ctx.market, engine: ctx.engine, config: ctx.config, scanner: ctx.scanner });
  ctx.app = createApp({ ...ctx, optionTrader });
  user = await registerUser(ctx.app);
});
afterEach(() => teardown(ctx));
after(closeDb);

// 09:15 IST on Monday 5 Oct 2026 is 03:45 UTC; a bar that opens at 09:15 closes at 09:20.
const OPEN = Date.UTC(2026, 9, 5, 3, 45) / 1000;
const at = (hh, mm) => OPEN + ((hh - 9) * 60 + (mm - 15)) * 60;

test('the entry window defaults to 09:15-15:15, takes the user\'s hours and ignores nonsense', () => {
  assert.deepEqual(entryWindowOf({}), { from: 555, to: 915 });
  assert.deepEqual(entryWindowOf({ entryFrom: 570, entryTo: 840 }), { from: 570, to: 840 });
  assert.deepEqual(entryWindowOf({ entryFrom: 100, entryTo: 2000 }), { from: 555, to: 915 });
  const test10to14 = entryTest({ from: 600, to: 840 });
  assert.equal(test10to14(at(9, 30)), false);
  assert.equal(test10to14(at(10, 0)), true); // the bar closing at 10:05
  assert.equal(test10to14(at(13, 50)), true);
  assert.equal(test10to14(at(14, 0)), false);
  assert.equal(entryTestOf({}), null, 'no hours given: the usual rules apply');
  assert.equal(entryTestOf({ entryFrom: 600, entryTo: 840 })(at(9, 30)), false);
});

test('the entry hours are saved in Account > Limits, must be 15 minutes apart, and default to today\'s hours', async () => {
  const first = (await api().get('/api/options').set(user.auth).expect(200)).body.settings;
  assert.deepEqual([first.entryFrom, first.entryTo, first.sensexOwn], [555, 915, false]);
  const saved = (await api().put('/api/options').set(user.auth).send({ entryFrom: 585, entryTo: 870 }).expect(200)).body.settings;
  assert.deepEqual([saved.entryFrom, saved.entryTo], [585, 870]);
  await api().put('/api/options').set(user.auth).send({ entryFrom: 600, entryTo: 605 }).expect(400);
  await api().put('/api/options').set(user.auth).send({ entryTo: 580 }).expect(400); // against the saved start
  await api().put('/api/options').set(user.auth).send({ entryFrom: 500 }).expect(400);
  await api().put('/api/options').set(user.auth).send({ entryTo: 1000 }).expect(400);
});

test('a combination can belong to one index; with none it is for both, and studies include switched-off ones', () => {
  const list = normalizeCombos([
    { name: 'Both', conds: ['rsiAbove50'] },
    { name: 'Sensex only', conds: ['emaStack'], index: 'SENSEX' },
    { name: 'Off for live', conds: ['macdZero'], on: false },
    { name: 'Odd', conds: ['rsiAbove50'], index: 'BANKNIFTY' },
  ]);
  assert.equal(list[0].index, undefined);
  assert.equal(list[1].index, 'SENSEX');
  assert.equal(list[3].index, undefined, 'an unknown index is dropped');
  assert.equal(comboFitsIndex(list[1], 'NIFTY'), false);
  assert.equal(comboFitsIndex(list[1], 'SENSEX'), true);
  assert.equal(comboFitsIndex(list[0], 'SENSEX'), true);
  assert.deepEqual(studyCombos(list, 'NIFTY').map((c) => c.name), ['Both', 'Off for live', 'Odd']);
  assert.deepEqual(studyCombos(list, 'SENSEX').map((c) => c.name), ['Both', 'Sensex only', 'Off for live', 'Odd']);
});

test('Sensex uses the Nifty setup until its own is switched on, for the stop and the profit ladder', async () => {
  assert.deepEqual(stopRuleOf({ patternStopMode: 'fixed', patternStopPoints: 40, sensexOwn: false, sensexStopPoints: 150 }, 'SENSEX'), { mode: 'fixed', k: 2, points: 40 });
  assert.deepEqual(stopRuleOf({ patternStopMode: 'fixed', patternStopPoints: 40, sensexOwn: true, sensexStopMode: 'atr', sensexStopAtr: 1.5, sensexStopPoints: 150 }, 'SENSEX'), { mode: 'atr', k: 1.5, points: 150 });
  assert.equal(stopRuleOf({ patternStopMode: 'fixed', patternStopPoints: 40, sensexOwn: true }, 'NIFTY').points, 40);

  const d0 = (await api().get('/api/trade-defaults').set(user.auth).expect(200)).body;
  assert.equal(d0.sensex.own, false);
  assert.deepEqual(d0.sensex.steps, d0.options.steps, 'starts as a copy of the options rules');

  const put = (await api().put('/api/trade-defaults').set(user.auth).send({ options: { stopLoss: 1500, steps: [{ at: 1000, keep: 750 }] }, sensex: { own: true, stopLoss: 2500, steps: [{ at: 2000, keep: 1500 }, { at: 4000, keep: 3500 }] } }).expect(200)).body;
  assert.equal(put.sensex.own, true);
  assert.equal(put.sensex.stopLoss, 2500);
  assert.deepEqual(put.options.steps, [{ at: 1000, keep: 750 }], 'Nifty is not touched');

  const row = await TradeDefaults.findOne({}).lean();
  assert.equal(rulesFor(row, 'OPT', { index: 'SENSEX' }).stopLoss, 2500);
  assert.equal(rulesFor(row, 'OPT', { index: 'NIFTY' }).stopLoss, 1500);
  assert.equal(rulesFor(row, 'OPT').stopLoss, 1500);
  assert.deepEqual(rulesFor(row, 'OPT', { index: 'SENSEX' }).steps.map((s) => s.at), [2000, 4000]);

  const back = (await api().put('/api/trade-defaults').set(user.auth).send({ sensex: { own: false } }).expect(200)).body;
  assert.equal(rulesFor({ options: { ...back.options }, sensex: { ...back.sensex } }, 'OPT', { index: 'SENSEX' }).stopLoss, 1500);
  await api().put('/api/trade-defaults').set(user.auth).send({ sensex: { own: true, steps: [{ at: 100, keep: 200 }] } }).expect(400);
});

test('Sensex stop choices are saved and validated', async () => {
  const saved = (await api().put('/api/options').set(user.auth).send({ sensexOwn: true, sensexStopMode: 'fixed', sensexStopPoints: 200 }).expect(200)).body.settings;
  assert.deepEqual([saved.sensexOwn, saved.sensexStopMode, saved.sensexStopPoints], [true, 'fixed', 200]);
  await api().put('/api/options').set(user.auth).send({ sensexStopPoints: 5 }).expect(400);
  await api().put('/api/options').set(user.auth).send({ sensexStopMode: 'tight' }).expect(400);
});
