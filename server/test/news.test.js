import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { parseRss } from '../src/news/rss.js';
import { tagHeadline } from '../src/news/tagger.js';
import { reactionTo } from '../src/news/reaction.js';
import { summarise } from '../src/news/service.js';
import { evaluateStock } from '../src/scanner/evaluate.js';
import { NewsItem } from '../src/models/index.js';
import { setup, teardown, closeDb, registerUser } from './helpers.js';

after(closeDb);

const rss = (items) =>
  `<?xml version="1.0"?><rss><channel>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.date.toUTCString()}</pubDate><source url="https://x.test">${i.source || 'Mint'}</source></item>`)
    .join('')}</channel></rss>`;

test('rss: reads items, decodes entities and strips the publisher suffix', () => {
  const date = new Date('2026-10-22T04:00:00Z');
  const items = parseRss(rss([{ title: 'Infosys &amp; TCS win big - Mint', link: 'https://n.test/a?x=1&amp;y=2', date }, { title: '', link: 'https://n.test/b', date }]));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Infosys & TCS win big');
  assert.equal(items[0].url, 'https://n.test/a?x=1&y=2');
  assert.equal(items[0].source, 'Mint');
  assert.equal(items[0].publishedAt.toISOString(), date.toISOString());
});

test('tagger: results, orders, downgrades and legal trouble get the right side', () => {
  assert.equal(tagHeadline('TCS Q2 profit jumps 12%, beats estimates').label, 'BULLISH');
  assert.equal(tagHeadline('Infosys wins $1.5 billion order from European bank').category, 'ORDER_WIN');
  assert.equal(tagHeadline('Brokerage downgrades HDFC Bank to sell').label, 'BEARISH');
  assert.equal(tagHeadline('Reliance net profit declines 8% in the quarter').label, 'BEARISH');
  const legal = tagHeadline('SEBI issues show-cause notice to Adani Enterprises');
  assert.equal(legal.label, 'BEARISH');
  assert.equal(legal.category, 'REGULATORY');
  assert.ok(legal.reasons.length > 0);
});

test('tagger: quiet, speculative and mixed headlines stay neutral', () => {
  assert.equal(tagHeadline('Maruti opens new showroom in Pune').label, 'NEUTRAL');
  assert.equal(tagHeadline('Will Tata Motors rise this week?').label, 'NEUTRAL');
  assert.equal(tagHeadline('Wipro net profit rises, margins fall').label, 'NEUTRAL');
  assert.equal(tagHeadline('Company may win a big order').label, 'NEUTRAL'); // "may" halves the weight
});

test('reaction: compares the price now with the price when the news came out', () => {
  const t0 = 1_800_000_000;
  const c1 = [{ time: t0 - 60, close: 100 }, { time: t0 + 600, close: 101 }];
  const now = new Date((t0 + 1200) * 1000);
  const base = { c1, publishedAt: new Date(t0 * 1000), now };
  assert.equal(reactionTo({ ...base, label: 'BULLISH', ltp: 101 }).state, 'AGREES');
  assert.equal(reactionTo({ ...base, label: 'BULLISH', ltp: 99.4 }).state, 'FADING'); // good news sold
  assert.equal(reactionTo({ ...base, label: 'BEARISH', ltp: 99.4 }).state, 'AGREES');
  assert.equal(reactionTo({ ...base, label: 'BULLISH', ltp: 100.1 }).state, 'FLAT');
  assert.equal(reactionTo({ ...base, label: 'BULLISH', ltp: 101, now: new Date((t0 + 60) * 1000) }).state, 'TOO_EARLY');
  assert.equal(reactionTo({ ...base, label: 'NEUTRAL', ltp: 101 }), null);
  assert.equal(reactionTo({ ...base, label: 'BULLISH', ltp: 101, c1: [] }).state, 'UNKNOWN');
});

test('summarise: opposing headlines cancel, strong ones lead', () => {
  const item = (label, sentiment, title) => ({ label, sentiment, title, reaction: { state: 'AGREES', movePct: 0.5 } });
  assert.equal(summarise([item('BULLISH', 2, 'a'), item('BEARISH', -2, 'b')]), null);
  const s = summarise([item('BULLISH', 1, 'small'), item('BULLISH', 3, 'big')]);
  assert.equal(s.label, 'BULLISH');
  assert.equal(s.title, 'big');
  assert.equal(s.net, 4);
});

// --- scanner scoring with news ---
const DAY = 86400;
const T0 = Date.UTC(2026, 9, 21, 3, 45) / 1000;
const T1 = T0 + DAY;
function session(start, n, close, vol = () => 1000) {
  const out = [];
  let prev = close(0);
  for (let i = 0; i < n; i++) {
    const c = close(i);
    out.push({ time: start + i * 60, open: prev, high: Math.max(prev, c) + 0.2, low: Math.min(prev, c) - 0.2, close: c, volume: vol(i) });
    prev = c;
  }
  return out;
}
const prior = session(T0, 375, (i) => 1000 + (i % 2 ? 1 : -1));
const or = session(T1, 15, (i) => 1004 + 3.8 * Math.sin(i * 0.9), () => 1000);
const orHigh = Math.max(...or.map((b) => b.high));
const c1 = [...prior, ...or, ...session(T1 + 900, 15, (i) => orHigh - 2 + (3 * (i + 1)) / 15, () => 3000), ...session(T1 + 1800, 3, () => orHigh + 0.6, () => 3000)];
const tick = { symbol: 'X', ltp: c1.at(-1).close, open: 1000, high: orHigh + 1, low: 995, prevClose: 1000, changePct: 1, totalBuyQty: 5000, totalSellQty: 5000 };
const orb = (news) => evaluateStock({ symbol: 'X', tick, c1, niftyChangePct: 0.9, news }, {}).candidates.find((c) => c.setup === 'Opening range breakout' && c.side === 'BUY');
const sig = (label, reaction, movePct = 0.8) => ({ label, net: label === 'BULLISH' ? 2 : -2, count: 1, title: 'TCS wins big order', reaction, movePct });

test('scanner: confirmed news adds to the score, an unconfirmed one adds less', () => {
  const none = orb(null).score;
  const agrees = orb(sig('BULLISH', 'AGREES'));
  const flat = orb(sig('BULLISH', 'FLAT', 0));
  assert.ok(agrees.score > flat.score && flat.score > none, `${none} < ${flat.score} < ${agrees.score}`);
  assert.ok(agrees.checks.some((c) => c.id === 'news' && c.points === 10));
});

test('scanner: news against the trade and sold good news both cut the score', () => {
  const none = orb(null).score;
  const against = orb(sig('BEARISH', 'AGREES', -0.9));
  assert.ok(against.score <= none - 10);
  assert.ok(against.penalties.some((p) => /other way/.test(p)));
  const sold = orb(sig('BULLISH', 'FADING', -0.5));
  assert.equal(sold.score, none - 8);
  assert.ok(sold.penalties.some((p) => /sold/.test(p)));
});

// --- service and routes ---
let ctx;
after(async () => ctx && teardown(ctx));

test('service stores tagged headlines once and serves them with a market-reaction check', async () => {
  const now = new Date('2026-10-22T06:00:00Z');
  const posted = new Date('2026-10-22T04:30:00Z');
  const feed = rss([
    { title: 'Infosys wins $1 billion order from US bank - Mint', link: 'https://n.test/1', date: posted },
    { title: 'Infosys wins $1 billion order from US bank - Mint', link: 'https://n.test/1-dup', date: posted },
    { title: 'Infosys opens new campus', link: 'https://n.test/2', date: new Date('2026-10-22T03:00:00Z') },
    { title: 'Totally unrelated company profit jumps', link: 'https://n.test/3', date: posted },
    { title: 'Infosys old story: profit jumps', link: 'https://n.test/4', date: new Date('2026-10-10T03:00:00Z') },
  ]);
  ctx = await setup({}, { now: () => now, fetchText: async () => feed });
  await ctx.news.refresh('INFY');
  await ctx.news.refresh('INFY'); // the second pass must not duplicate anything
  assert.equal(await NewsItem.countDocuments({ symbol: 'INFY' }), 2);

  // 1-minute bars: price was 100 when the order was announced, 101 now
  const t = Math.floor(posted.getTime() / 1000);
  ctx.scanner.store.bars.set('INFY', [{ time: t - 120, open: 100, high: 100, low: 100, close: 100, volume: 1 }]);
  ctx.provider.setPrice('INFY', 101);
  const { auth } = await registerUser(ctx.app);
  const res = await request(ctx.app).get('/api/news?symbol=infy').set(auth).expect(200);
  assert.equal(res.body.items.length, 2);
  const win = res.body.items.find((i) => i.category === 'ORDER_WIN');
  assert.equal(win.label, 'BULLISH');
  assert.equal(win.reaction.state, 'AGREES');
  assert.match(res.body.disclaimer, /Not investment advice/);

  const sum = await request(ctx.app).get('/api/news/summary').set(auth).expect(200);
  assert.equal(sum.body.signals.INFY.label, 'BULLISH');
  assert.equal(sum.body.signals.INFY.reaction, 'AGREES');
  assert.equal(sum.body.signals.TCS, undefined);

  await request(ctx.app).get('/api/news?symbol=NOTASTOCK').set(auth).expect(400);
  await request(ctx.app).get('/api/news').expect(401);
});

test('one failing feed does not stop the others', async () => {
  const calls = [];
  const c = await setup({}, { fetchText: async (url) => { calls.push(url); if (calls.length === 1) throw new Error('503'); return rss([]); } });
  await c.news.refreshSome(3);
  assert.equal(calls.length, 4); // market feeds come first (2 urls), then one per stock
  await teardown(c);
});

test('tags guidance changes and promoter or institutional moves', async () => {
  const { tagHeadline } = await import('../src/news/tagger.js');
  assert.equal(tagHeadline('Infosys raises FY27 revenue guidance').label, 'BULLISH');
  assert.equal(tagHeadline('Company cuts guidance on weak demand').label, 'BEARISH');
  assert.equal(tagHeadline('Promoters offload 2% stake in block deal').label, 'BEARISH');
  assert.equal(tagHeadline('Mutual funds raise stake in Reliance').label, 'BULLISH');
});
