import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { buildExport, readImport, diffSettings, ImportError, FORMAT, VERSION } from '../src/settings/transfer.js';
import { keepSettingsInLive } from '../src/dayreplay/keepSettings.js';

// More > Settings > Copy settings: the file, its checks and the summary shown before an import.
// (The routes save through Mongo; the checks below run without a database.)

const combo = (id, extra = {}) => ({ id, name: id.toUpperCase(), conds: ['rsiAbove50', 'aboveVwap'], need: 2, window: 3, on: true, ...extra });

const saved = () => ({
  options: { _id: 'x', user: 'u1', __v: 0, createdAt: new Date(), minScore: 80, entryClock: '1m', pausedOn: '2026-11-26', combos: [combo('a', { side: 'CE', exits: { cut: 1500 } }), combo('b', { on: false })] },
  shares: { user: 'u1', maxOpen: 3, shareRules: { marketAgree: true, minRelVol: 1.2 }, combos: [combo('s1', { order: { risk: 400 } })] },
  rules: { user: 'u1', options: { stopLoss: 2000, steps: [{ at: 1000, keep: 700 }] } },
  learners: [{ kind: 'options', auto: true }, { kind: 'tune', evening: true }],
});

test('the file holds every setting and combination, never the owner, ids or "pause today"', () => {
  const f = buildExport(saved());
  assert.equal(f.format, FORMAT);
  assert.equal(f.version, VERSION);
  assert.equal(f.options.minScore, 80);
  assert.equal(f.options.entryClock, '1m');
  assert.equal(f.options.budget, 60000); // a default, written out so the other login gets the same value
  assert.deepEqual(f.options.combos.map((c) => [c.id, c.on, c.side ?? null]), [['a', true, 'CE'], ['b', false, null]]);
  assert.equal(f.options.combos[0].exits.cut, 1500);
  assert.equal(f.shares.shareRules.marketAgree, true);
  assert.equal(f.shares.combos[0].order.risk, 400);
  assert.equal(f.rules.options.stopLoss, 2000);
  assert.deepEqual(f.rules.options.steps, [{ at: 1000, keep: 700 }]);
  assert.deepEqual(f.learner, { options: { auto: true }, shares: { auto: false }, tune: { evening: true } });
  const text = JSON.stringify(f);
  for (const k of ['"_id"', '"user"', '"__v"', '"createdAt"', '"updatedAt"', '"pausedOn"', 'u1']) assert.ok(!text.includes(k), `${k} must not be in the file`);
});

test('nothing saved yet: the file has the defaults', () => {
  const f = buildExport({ options: null, shares: null, rules: null });
  assert.equal(f.options.minScore, 70);
  assert.deepEqual(f.options.combos, []);
  assert.equal(f.rules.shares.stopLoss, 200);
});

test('a file read back gives the same settings (round trip)', () => {
  const f = buildExport(saved());
  const back = JSON.parse(JSON.stringify(f));
  const r = readImport(back);
  assert.deepEqual(r.ignored, []);
  assert.deepEqual(r.docs.options, f.options);
  assert.deepEqual(r.docs.shares, f.shares);
  assert.deepEqual(r.docs.rules, f.rules);
  assert.deepEqual(r.learner, f.learner);
  assert.equal(diffSettings(f, r, back).total, 0);
});

test('files that are not ours, from a newer app, or damaged are refused with a plain reason', () => {
  const f = buildExport(saved());
  const bad = [
    [null, /not a settings file/],
    [[], /not a settings file/],
    [{ hello: 1 }, /not a Trade Helper settings file/],
    [{ ...f, format: 'other' }, /not a Trade Helper settings file/],
    [{ ...f, version: 'one' }, /no valid version/],
    [{ ...f, version: VERSION + 1 }, /newer version/],
    [{ format: FORMAT, version: 1 }, /no settings in it/],
    [{ ...f, options: { ...f.options, minScore: 'abc' } }, /Options bot: "minScore"/],
    [{ ...f, options: { ...f.options, minScore: 10 } }, /Options bot: "minScore"/],
    [{ ...f, options: { ...f.options, entryClock: '9s' } }, /entryClock/],
    [{ ...f, shares: { ...f.shares, maxOpen: -1 } }, /Shares bot: "maxOpen"/],
    [{ ...f, options: { ...f.options, combos: 'lots' } }, /combinations are damaged/],
    [{ ...f, rules: [1, 2] }, /damaged/],
    [{ ...f, options: { ...f.options, entryFrom: 700, entryTo: 600 } }, /trading hours/],
  ];
  for (const [file, msg] of bad) assert.throws(() => readImport(file), (e) => e instanceof ImportError && msg.test(e.message), JSON.stringify(file)?.slice(0, 80));
});

test('unknown keys are left out safely and named; a combination with unknown checks is named too', () => {
  const f = buildExport(saved());
  const r = readImport({ ...f, extra: { token: 'x' }, options: { ...f.options, newThing: 5, user: 'someone-else', combos: [...f.options.combos, { id: 'z', name: 'Future combo', conds: ['notAThing'] }] }, rules: { ...f.rules, apiKey: 'k' } });
  assert.deepEqual(r.ignored.sort(), ['extra', 'options.combos: Future combo', 'options.newThing', 'rules.apiKey'].sort());
  assert.equal(r.docs.options.newThing, undefined);
  assert.equal(r.docs.options.user, undefined);
  assert.deepEqual(r.docs.options.combos.map((c) => c.id), ['a', 'b']);
});

test('settings left out of the file go back to their defaults (a full replace)', () => {
  const r = readImport({ format: FORMAT, version: 1, options: { minScore: 90 } });
  assert.equal(r.docs.options.minScore, 90);
  assert.equal(r.docs.options.entryClock, '5m');
  assert.deepEqual(r.docs.options.combos, []);
  assert.equal(r.docs.shares.maxOpen, 2);
  assert.deepEqual(r.learner, { options: { auto: false }, shares: { auto: false }, tune: { evening: false } });
});

test('the summary names each changed setting and the combinations added, removed and changed', () => {
  const cur = buildExport(saved());
  const next = buildExport(saved());
  next.options.minScore = 75;
  next.options.combos = [{ ...next.options.combos[0], need: 1 }, combo('c')];
  next.shares.shareRules.minRelVol = 2;
  next.rules.options.steps = [];
  next.learner.options.auto = false;
  const d = diffSettings(cur, readImport(next), next);
  const opt = d.sections.find((s) => s.key === 'options');
  assert.deepEqual(opt.changes, [{ key: 'minScore', from: '80', to: '75' }]);
  assert.deepEqual(opt.combos, { count: 2, on: 2, added: ['C'], removed: ['B'], changed: ['A'] });
  assert.deepEqual(d.sections.find((s) => s.key === 'shares').changes, [{ key: 'shareRules.minRelVol', from: '1.2', to: '2' }]);
  assert.deepEqual(d.sections.find((s) => s.key === 'rules').changes, [{ key: 'options.steps', from: '1 rows', to: 'none' }]);
  assert.deepEqual(d.sections.find((s) => s.key === 'learner').changes, [{ key: 'options.auto', from: 'on', to: 'off' }]);
  assert.equal(d.total, 7);
});

test('an import made in a replay is saved in the live app first', async () => {
  const sent = [];
  const app = express();
  app.use(express.json());
  app.use(keepSettingsInLive({ livePort: 4000, fetchFn: async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), { ok: true, status: 200 }) }));
  app.put('/api/settings-transfer', (_req, res) => res.json({ ok: true }));
  await request(app).put('/api/settings-transfer').send({ file: { format: FORMAT }, confirm: true }).expect(200);
  assert.deepEqual(sent, [{ url: 'http://127.0.0.1:4000/api/settings-transfer', body: { file: { format: FORMAT }, confirm: true } }]);
});
