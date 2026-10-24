import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BaseProvider } from '../src/market/providers/BaseProvider.js';
import { MockProvider } from '../src/market/providers/MockProvider.js';
import { UpstoxProvider } from '../src/market/providers/upstox/UpstoxProvider.js';

// The app is paper trading only. These tests fail if anything starts talking to a broker's order API.

const methods = (cls) => Object.getOwnPropertyNames(cls.prototype);

test('market data providers can read prices but expose no way to place, modify or cancel broker orders', () => {
  for (const cls of [BaseProvider, MockProvider, UpstoxProvider]) {
    const bad = methods(cls).filter((m) => /order|trade|buy|sell|square|position/i.test(m));
    assert.deepEqual(bad, [], `${cls.name} has trading methods: ${bad.join(', ')}`);
  }
});

function sources(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('no source file calls a broker order endpoint', () => {
  const endpoints = [/order\/place/i, /orders\/place/i, /\/order\/modify/i, /\/order\/cancel/i, /\/v2\/order/i, /\/v3\/order/i, /getTradeBook/, /rest\/secure\/angelbroking\/order/i];
  const root = path.resolve(import.meta.dirname, '../src');
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8');
    for (const re of endpoints) assert.ok(!re.test(text), `${path.relative(root, file)} mentions a broker order endpoint (${re})`);
  }
});
