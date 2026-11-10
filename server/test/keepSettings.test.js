import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { keepSettingsInLive } from '../src/dayreplay/keepSettings.js';

// A replay copy with stand-in settings routes; `fetchFn` records what would be sent to the live app.
function replayApp({ status = 200 } = {}) {
  const sent = [];
  const fetchFn = async (url, init) => {
    sent.push({ url, method: init.method, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const app = express();
  app.use(express.json());
  app.use(keepSettingsInLive({ livePort: 4000, fetchFn }));
  for (const p of ['/api/options', '/api/auto', '/api/trade-defaults', '/api/orders']) app.put(p, (_req, res) => res.status(status).json({ ok: status < 300 }));
  return { app, sent };
}

const settle = () => new Promise((r) => setImmediate(r));
const list = [{ id: 'a', name: 'A', conds: ['rsiAbove50'], on: false }];

test('settings changed in a replay are also saved in the live app', async () => {
  const { app, sent } = replayApp();
  await request(app).put('/api/options').set('Authorization', 'Bearer t').send({ combos: list }).expect(200);
  await request(app).put('/api/options').set('Authorization', 'Bearer t').send({ entryClock: '1s' }).expect(200);
  await request(app).put('/api/auto').set('Authorization', 'Bearer t').send({ combos: [] }).expect(200);
  await request(app).put('/api/trade-defaults').set('Authorization', 'Bearer t').send({ options: { lockStart: 1000 } }).expect(200);
  await settle();
  assert.deepEqual(sent, [
    { url: 'http://127.0.0.1:4000/api/options', method: 'PUT', auth: 'Bearer t', body: { combos: list } },
    { url: 'http://127.0.0.1:4000/api/options', method: 'PUT', auth: 'Bearer t', body: { entryClock: '1s' } },
    { url: 'http://127.0.0.1:4000/api/auto', method: 'PUT', auth: 'Bearer t', body: { combos: [] } },
    { url: 'http://127.0.0.1:4000/api/trade-defaults', method: 'PUT', auth: 'Bearer t', body: { options: { lockStart: 1000 } } },
  ]);
});

test('"pause today" stays in the replay, other routes are left alone, and a refused change is not passed on', async () => {
  const { app, sent } = replayApp();
  await request(app).put('/api/options').send({ pauseToday: true }).expect(200);
  await request(app).put('/api/options').send({ enabled: true, pauseToday: true }).expect(200);
  await request(app).put('/api/orders').send({ combos: list }).expect(200);
  await settle();
  assert.deepEqual(sent.map((s) => s.body), [{ enabled: true }]);
  const refused = replayApp({ status: 400 });
  await request(refused.app).put('/api/options').send({ combos: list }).expect(400);
  await settle();
  assert.equal(refused.sent.length, 0);
});
