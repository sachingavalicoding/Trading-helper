import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser } from './helpers.js';
import { OptionSettings } from '../src/models/index.js';

// The settings file routes end to end: one login exports, another imports it and ends up with the same settings.
let ctx;
before(async () => {
  ctx = await setup();
});
after(async () => {
  await teardown(ctx);
  await closeDb();
});

const combo = (id) => ({ id, name: id, conds: ['rsiAbove50', 'aboveVwap'], need: 2 });

test('export from one login, import into another: settings are replaced, trades and login stay', async () => {
  const me = await registerUser(ctx.app);
  const brother = await registerUser(ctx.app);
  await request(ctx.app).put('/api/options').set(me.auth).send({ minScore: 85, entryClock: '1m', combos: [combo('mine')] }).expect(200);
  await request(ctx.app).put('/api/auto').set(me.auth).send({ maxOpen: 4, shareRules: { marketAgree: true } }).expect(200);
  await request(ctx.app).put('/api/trade-defaults').set(me.auth).send({ options: { stopLoss: 1800 } }).expect(200);
  await request(ctx.app).put('/api/options').set(brother.auth).send({ maxLots: 7, combos: [combo('his-old')] }).expect(200);

  const file = (await request(ctx.app).get('/api/settings-transfer/export?download=1').set(me.auth).expect(200)).body;
  assert.ok(!JSON.stringify(file).includes(String(me.user.id)));

  const preview = (await request(ctx.app).post('/api/settings-transfer/preview').set(brother.auth).send({ file }).expect(200)).body;
  const opt = preview.sections.find((s) => s.key === 'options');
  assert.deepEqual(opt.combos.added, ['mine']);
  assert.deepEqual(opt.combos.removed, ['his-old']);
  assert.ok(opt.changes.some((c) => c.key === 'maxLots' && c.from === '7' && c.to === '2'));

  await request(ctx.app).put('/api/settings-transfer').set(brother.auth).send({ file }).expect(400); // no confirm
  await request(ctx.app).put('/api/settings-transfer').set(brother.auth).send({ file, confirm: true }).expect(200);

  const again = (await request(ctx.app).get('/api/settings-transfer/export').set(brother.auth).expect(200)).body;
  for (const k of ['options', 'shares', 'rules', 'learner']) assert.deepEqual(again[k], file[k], k);
  const saved = await OptionSettings.findOne({ user: brother.user.id }).lean();
  assert.equal(String(saved.user), String(brother.user.id));
  assert.equal((await OptionSettings.countDocuments({ user: me.user.id })), 1);
});

test('a bad file is refused and changes nothing', async () => {
  const u = await registerUser(ctx.app);
  await request(ctx.app).put('/api/options').set(u.auth).send({ minScore: 77 }).expect(200);
  const res = await request(ctx.app).post('/api/settings-transfer/preview').set(u.auth).send({ file: { format: 'nope' } }).expect(400);
  assert.equal(res.body.error.code, 'BAD_SETTINGS_FILE');
  await request(ctx.app).put('/api/settings-transfer').set(u.auth).send({ file: { format: 'trade-helper-settings', version: 1, options: { minScore: 'x' } }, confirm: true }).expect(400);
  assert.equal((await OptionSettings.findOne({ user: u.user.id }).lean()).minScore, 77);
});

test('a big file (more than the normal 50 kB) is accepted', async () => {
  const u = await registerUser(ctx.app);
  const file = (await request(ctx.app).get('/api/settings-transfer/export').set(u.auth).expect(200)).body;
  const big = { ...file, padding: 'x'.repeat(120_000) };
  const res = await request(ctx.app).post('/api/settings-transfer/preview').set(u.auth).send({ file: big }).expect(200);
  assert.deepEqual(res.body.ignored, ['padding']);
});

test('the routes need a login', async () => {
  await request(ctx.app).get('/api/settings-transfer/export').expect(401);
});
