import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { setup, teardown, closeDb, registerUser } from './helpers.js';

let ctx;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
  ctx = await setup({ clientDist: dir });
});
after(async () => {
  await teardown(ctx);
  await closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('serves the web app and falls back to index.html for app routes', async () => {
  const root = await request(ctx.app).get('/').expect(200);
  assert.match(root.text, /<title>app<\/title>/);
  const deep = await request(ctx.app).get('/dashboard').expect(200);
  assert.match(deep.text, /<title>app<\/title>/);
  await request(ctx.app).get('/app.js').expect(200);
});

test('unknown API paths still return JSON 404, and missing files 404', async () => {
  const res = await request(ctx.app).get('/api/nope').set((await registerUser(ctx.app)).auth).expect(404);
  assert.equal(res.body.error.code, 'NOT_FOUND');
  await request(ctx.app).get('/missing.js').expect(404);
});

test('the Upstox login pages only answer the device running the server', async () => {
  const { loopbackOnly } = await import('../src/routes/upstox.js');
  const run = (remoteAddress) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, send() { return this; } };
    let called = false;
    loopbackOnly({ socket: { remoteAddress } }, res, () => { called = true; });
    return { called, code: res.code };
  };
  assert.equal(run('127.0.0.1').called, true);
  assert.equal(run('::1').called, true);
  assert.equal(run('::ffff:127.0.0.1').called, true);
  assert.deepEqual(run('192.168.1.20'), { called: false, code: 403 });
  assert.deepEqual(run(undefined), { called: false, code: 403 });
});
