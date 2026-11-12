import test from 'node:test';
import assert from 'node:assert/strict';
import { EntryGuard, CLAIM_MS } from '../src/options/entryGuard.js';

// A stand-in for the EntryClaim collection with its unique key: a live claim of another owner cannot be taken.
function memoryClaims() {
  const rows = new Map();
  return {
    rows,
    async take(key, owner, now) {
      await new Promise((r) => setImmediate(r)); // a database call is never instant
      const row = rows.get(key);
      if (row && row.until > now && row.owner !== owner) return false;
      rows.set(key, { owner, until: new Date(now.getTime() + CLAIM_MS) });
      return true;
    },
    async drop(key, owner) {
      if (rows.get(key)?.owner === owner) rows.delete(key);
    },
  };
}

// The 12 Nov double buy in miniature: the check "already holding?" and the buy are a few awaits apart.
function fakeBroker() {
  const held = new Set();
  let orders = 0;
  return {
    get orders() {
      return orders;
    },
    async enter(symbol) {
      if (held.has(symbol)) return { skipped: 'already holding a PE' };
      await new Promise((r) => setTimeout(r, 5)); // contract pick, funds, sizing
      held.add(symbol);
      orders += 1;
      return { order: orders };
    },
  };
}

test('without the guard two entries started together both buy (the 12 Nov bug)', async () => {
  const broker = fakeBroker();
  await Promise.all([broker.enter('NIFTY-25200-PE'), broker.enter('NIFTY-25200-PE')]);
  assert.equal(broker.orders, 2);
});

test('in one server, two entries for the same user run one after the other, so the second sees the first position', async () => {
  const guard = new EntryGuard({ claims: memoryClaims() });
  const broker = fakeBroker();
  const [a, b] = await Promise.all([guard.run('u1', () => broker.enter('NIFTY-25200-PE')), guard.run('u1', () => broker.enter('NIFTY-25200-PE'))]);
  assert.equal(broker.orders, 1);
  assert.ok(a.order);
  assert.equal(b.skipped, 'already holding a PE');
});

test('two servers on one database: the one without the claim does not buy', async () => {
  const claims = memoryClaims();
  const laptop = new EntryGuard({ claims, owner: 'laptop' });
  const phone = new EntryGuard({ claims, owner: 'phone' });
  const broker = fakeBroker();
  const [a, b] = await Promise.all([laptop.run('u1', () => broker.enter('NIFTY-25200-PE')), phone.run('u1', () => broker.enter('NIFTY-25200-PE'))]);
  assert.equal(broker.orders, 1);
  assert.ok(a.order || b.order);
  assert.ok(a.busy || b.busy || a.skipped || b.skipped);
});

test('the claim is let go after the buy (and after a failure), and a stale claim of a dead server does not block', async () => {
  const claims = memoryClaims();
  const guard = new EntryGuard({ claims, owner: 'a' });
  await guard.run('u1', async () => ({ order: 1 }));
  assert.equal(claims.rows.size, 0);
  await assert.rejects(guard.run('u1', async () => {
    throw new Error('order failed');
  }));
  assert.equal(claims.rows.size, 0);
  claims.rows.set('OPT|u1', { owner: 'dead', until: new Date(Date.now() - 1) });
  assert.deepEqual(await guard.run('u1', async () => ({ order: 2 })), { order: 2 });
});

test('different users do not wait for each other', async () => {
  const guard = new EntryGuard({ claims: memoryClaims() });
  let release;
  const slow = guard.run('u1', () => new Promise((r) => (release = r)));
  const other = await guard.run('u2', async () => 'done');
  assert.equal(other, 'done');
  release('ok');
  assert.equal(await slow, 'ok');
});
