import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { LearnerState, OptionSettings, AutoSettings, AutoLog, OptionCandleDay } from '../src/models/index.js';
import { LearnerService } from '../src/learner/service.js';
import { LEARNER_SLOT } from '../src/learner/learn.js';

// The service against in-memory stand-ins for the collections (no database needed): what it saves, what it changes and what it undoes.
const stores = new Map();
function fake(Model, match = (doc, q) => Object.entries(q).every(([k, v]) => (typeof v === 'object' && v && '$ne' in v ? doc[k] !== v.$ne : String(doc[k]) === String(v)))) {
  const rows = [];
  stores.set(Model, rows);
  const query = (found) => ({ lean: async () => (found ? found.toObject() : null), then: (res, rej) => Promise.resolve(found).then(res, rej) });
  Model.findOne = (q) => query(rows.find((d) => match(d, q)) ?? null);
  Model.prototype.save = async function save() {
    if (!rows.includes(this)) rows.push(this);
    return this;
  };
  return rows;
}
fake(LearnerState);
fake(OptionSettings);
fake(AutoSettings);
let liveLogs = [];
AutoLog.find = (q) => ({ sort: () => ({ limit: () => ({ lean: async () => liveLogs }) }), lean: async () => liveLogs.filter((r) => r.decidedAt >= q.decidedAt.$gte) });
OptionCandleDay.distinct = async () => Array.from({ length: 20 }, (_, i) => `d${i}`);

const user = new mongoose.Types.ObjectId();
const found = (conds, side = null) => ({ verdict: 'found', text: 'Found', pick: { name: 'Learner: x', conds, labels: conds, side, sideText: 'calls only', train: { trades: 12, net: 2000 }, test: { trades: 6, net: 500 } }, baseline: { test: { net: 100 } }, candidates: [], tried: 10, trainDays: 20, testDays: 10 });
function service(answer) {
  const calls = [];
  const study = {
    learnRun: async (userId, kind, opts) => {
      calls.push({ kind, ...opts });
      return { period: { days: 30 }, pricing: { mode: 'real' }, learned: typeof answer === 'function' ? answer(opts) : answer };
    },
  };
  return { learner: new LearnerService({ study, market: { provider: { isSimulated: false } }, now: () => new Date('2026-11-12T11:30:00Z') }), calls };
}

test('learner service: with auto off it only suggests; Use puts the pick in its own slot next to your combinations', async () => {
  await new OptionSettings({ user, enabled: true, combos: [{ id: 'mine', name: 'Mine', conds: ['rsiAbove50', 'macdZero'] }] }).save();
  const { learner, calls } = service(found(['emaStack', 'rsiAbove50'], 'CE'));
  await learner.start(String(user), 'options').done;
  assert.equal(calls[0].realPrices, true, '20 saved days: real prices');
  assert.equal(calls[0].days, 30);
  let v = await learner.view(String(user), 'options');
  assert.equal(v.last.verdict, 'found');
  assert.equal(v.slot, null, 'auto is off: nothing changed');
  assert.equal(v.log[0].action, 'checked');
  v = await learner.use(String(user), 'options');
  assert.equal(v.slot.id, LEARNER_SLOT);
  assert.equal(v.slot.side, 'CE');
  assert.deepEqual(v.slot.conds, ['emaStack', 'rsiAbove50']);
  const saved = (await OptionSettings.findOne({ user })).combos.map((c) => c.id);
  assert.deepEqual(saved, ['mine', LEARNER_SLOT], 'your own combination is kept');
});

test('learner service: auto on replaces, keeps, or switches its pick off; undo takes it out and turns auto off', async () => {
  let answer = found(['aboveVwap', 'rsiAbove50']);
  const { learner } = service(() => answer);
  await learner.setAuto(String(user), 'options', true);
  await learner.start(String(user), 'options').done;
  let v = await learner.view(String(user), 'options');
  assert.equal(v.log[0].action, 'replaced');
  assert.deepEqual(v.slot.conds, ['aboveVwap', 'rsiAbove50']);
  await learner.start(String(user), 'options').done;
  v = await learner.view(String(user), 'options');
  assert.equal(v.log[0].action, 'kept');
  answer = { verdict: 'none', text: 'No edge found.', candidates: [], previousResult: { passed: false, why: ['lost money on the newest days it never saw'] } };
  await learner.start(String(user), 'options').done;
  v = await learner.view(String(user), 'options');
  assert.equal(v.log[0].action, 'paused');
  assert.equal(v.slot.on, false);
  liveLogs = [{ decidedAt: new Date('2026-11-12T11:30:00Z'), outcome: { netPnl: -200 } }];
  v = await learner.view(String(user), 'options');
  const replaced = v.log.find((e) => e.action === 'replaced');
  assert.deepEqual(replaced.live, { trades: 1, wins: 0, net: -200, ended: false }, 'how the pick did live, until the next change');
  v = await learner.undo(String(user), 'options');
  assert.equal(v.slot, null);
  assert.equal(v.auto, false);
  assert.deepEqual((await OptionSettings.findOne({ user })).combos.map((c) => c.id), ['mine']);
  liveLogs = [];
});

test('learner service: a failed run is shown, not hidden', async () => {
  const study = { learnRun: async () => { throw new Error('Not enough NIFTY history came back'); } };
  const learner = new LearnerService({ study, market: { provider: {} } });
  await learner.start(String(user), 'shares').done;
  const v = await learner.view(String(user), 'shares');
  assert.equal(v.last.verdict, 'failed');
  assert.match(v.last.text, /Not enough NIFTY history/);
});

test('learner service: shares pick is switched off after 3 live losses in a row', async () => {
  const u = new mongoose.Types.ObjectId();
  await new AutoSettings({ user: u, enabled: true, combos: [{ id: LEARNER_SLOT, name: 'Learner: x', conds: ['rsiAbove50'] }] }).save();
  const { learner } = service(found(['rsiAbove50']));
  liveLogs = [{ outcome: { netPnl: -10 } }, { outcome: { netPnl: -20 } }];
  assert.equal(await learner.benchShares(u), false, 'two losses: still on');
  liveLogs.push({ outcome: { netPnl: -5 } });
  LearnerState.updateOne = async () => ({});
  assert.equal(await learner.benchShares(u), true);
  const slot = (await AutoSettings.findOne({ user: u })).combos[0];
  assert.equal(slot.on, false);
  assert.ok(slot.benchedOn);
  liveLogs = [];
});
