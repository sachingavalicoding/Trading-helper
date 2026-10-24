// Checks your Angel One setup step by step and says exactly which step fails.
//   npm run angel:check
// Needs ANGELONE_* in server/.env. Prints no secrets. Run it once before MARKET_DATA_PROVIDER=angelone.
import { env } from '../src/config/env.js';
import { AngelOneProvider } from '../src/market/providers/angelone/AngelOneProvider.js';
import { looksSane } from '../src/market/providers/angelone/packet.js';

const step = (ok, msg) => console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`);
const provider = new AngelOneProvider(env.angelone);
let ticks = 0;
const seen = [];
provider.on('tick', (t) => {
  ticks++;
  if (seen.length < 4 && !seen.some((s) => s.symbol === t.symbol)) seen.push(t);
});
provider.on('status', (s) => console.log(`     feed: ${s.message}`));

try {
  await provider.connect();
  step(true, 'login, instrument tokens and websocket connection');
} catch (err) {
  step(false, err.message);
  process.exit(1);
}

try {
  await provider.subscribe(['RELIANCE', 'TCS', 'INFY', 'NIFTY 50']);
  const candles = await provider.getHistory('RELIANCE', '5m');
  step(candles.length > 0, `history: ${candles.length} five-minute candles for RELIANCE${candles.length ? `, last close ${candles.at(-1).close}` : ' (empty: market holiday, or the candle call failed)'}`);
} catch (err) {
  step(false, `history: ${err.message}`);
}

console.log('     waiting up to 20 seconds for live quotes (the market may be closed, then you may see the last prices or nothing)...');
await new Promise((r) => setTimeout(r, 20_000));
step(ticks > 0, `${ticks} live quotes received`);
for (const t of seen) {
  console.log(`     ${t.symbol}: ltp ${t.ltp}, open ${t.open}, high ${t.high}, low ${t.low}, prev close ${t.prevClose}, volume ${t.volume}, depth levels ${t.depth?.bids.length ?? 0}/${t.depth?.asks.length ?? 0}`);
}
const bad = seen.filter((t) => !looksSane({ ltp: t.ltp, high: t.high, low: t.low, volume: t.volume ?? 0 }));
if (bad.length) step(false, `prices look inconsistent for ${bad.map((b) => b.symbol).join(', ')}. The feed layout may differ, send me this output`);
await provider.disconnect();
process.exit(0);
