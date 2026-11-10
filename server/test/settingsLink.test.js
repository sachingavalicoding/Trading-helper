import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SettingsSync } from '../src/dayreplay/settingsLink.js';

// In-memory stand-ins for the live and the replay databases.
function dbs() {
  const live = new Map([['optionsettings', [{ _id: 'o1', user: 'u', enabled: true, entryClock: '5m' }]], ['autosettings', [{ _id: 'a1', user: 'u', enabled: false }]]]);
  const replay = new Map();
  const writes = [];
  const sync = new SettingsSync({
    names: ['optionsettings', 'autosettings'],
    read: async (n) => (live.get(n) ?? []).map((d) => ({ ...d })),
    replace: async (n, docs) => {
      writes.push(n);
      replay.set(n, docs);
    },
  });
  return { live, replay, writes, sync };
}

test('the live settings reach the replay, and again whenever they change', async () => {
  const { live, replay, writes, sync } = dbs();
  assert.deepEqual(await sync.syncNow(), ['optionsettings', 'autosettings']);
  assert.equal(replay.get('optionsettings')[0].entryClock, '5m');
  assert.deepEqual(await sync.syncNow(), [], 'nothing changed: nothing written');
  live.get('optionsettings')[0].entryClock = '1s';
  live.get('autosettings')[0].enabled = true;
  assert.deepEqual(await sync.syncNow(), ['optionsettings', 'autosettings']);
  assert.equal(replay.get('optionsettings')[0].entryClock, '1s');
  assert.equal(replay.get('autosettings')[0].enabled, true);
  live.get('optionsettings').length = 0; // deleted in the live app
  await sync.syncNow();
  assert.deepEqual(replay.get('optionsettings'), []);
  assert.equal(writes.length, 5);
});

test('a read failure leaves the replay as it was', async () => {
  const { replay, sync } = dbs();
  await sync.syncNow();
  sync.read = async () => {
    throw new Error('live database down');
  };
  assert.deepEqual(await sync.syncNow(), []);
  assert.equal(replay.get('optionsettings').length, 1);
});
