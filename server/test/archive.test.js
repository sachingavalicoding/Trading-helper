import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { mkdtemp, readdir, writeFile, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { YearFiles, YearDownload, TempImports, monthsBack, monthEnd, candlesOf } from '../src/archive/yearFiles.js';
import { OptionArchive, splitParts, partName } from '../src/archive/optionArchive.js';
import { Mailer } from '../src/archive/mailer.js';
import { yearDataRoutes } from '../src/routes/yearData.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { packOptionCandles } from '../src/market/optionHistory.js';
import { addDays } from '../src/market/days.js';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'archive-'));
const at = (iso) => () => new Date(iso);

// 09:15-15:29 IST candles on every weekday between two days
function series(fromDay, toDay) {
  const out = [];
  for (let day = fromDay; day <= toDay; day = addDays(day, 1)) {
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const t0 = Date.parse(`${day}T03:45:00Z`) / 1000;
    for (let i = 0; i < 375; i++) out.push({ time: t0 + i * 60, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 + i });
  }
  return out;
}

function fakeMarket({ failFor = [], reject400Over = 0 } = {}) {
  const calls = [];
  return {
    calls,
    provider: {
      isSimulated: false,
      async getCandlesBetween(symbol, _unit, from, to) {
        calls.push(`${symbol} ${from}..${to}`);
        if (failFor.includes(symbol)) throw new Error('HTTP 500 boom');
        if (reject400Over && (Date.parse(to) - Date.parse(from)) / 86400000 + 1 > reject400Over) throw new Error('HTTP 400 range too long');
        return series(from, to);
      },
    },
  };
}
const waitDone = async (x) => {
  while (x.status().state === 'running') await new Promise((r) => setTimeout(r, 5));
  return x.status();
};
const small = [{ key: 'nifty', label: 'Nifty', symbols: ['NIFTY 50'] }, { key: 'shares', label: 'Shares', symbols: ['AAA', 'BBB'] }];

test('month helpers', () => {
  assert.equal(monthEnd('2026-02'), '2026-02-28');
  assert.equal(monthEnd('2028-02'), '2028-02-29');
  assert.deepEqual(monthsBack('2026-02-10', 3), ['2025-12', '2026-01', '2026-02']);
});

test('the download writes one compressed file per group and year, skips what is saved, and resumes after a failure', async () => {
  const dir = await tmp();
  const files = new YearFiles({ dir });
  const market = fakeMarket({ failFor: ['BBB'] });
  const dl = new YearDownload({ market, files, groups: small, now: at('2026-02-12T08:00:00Z') });
  dl.start({ months: 3 });
  const job = await waitDone(dl);
  assert.equal(job.state, 'partial'); // BBB failed in all 3 months, the rest is saved
  assert.equal(job.failed.length, 3);
  assert.deepEqual((await readdir(dir)).filter((n) => n.endsWith('.gz')).sort(), ['nifty-2025.json.gz', 'nifty-2026.json.gz', 'shares-2025.json.gz', 'shares-2026.json.gz']);
  const nifty26 = await files.load('nifty', 2026);
  assert.equal(nifty26.format, 'nifty-candles-year-1');
  assert.match(nifty26.source, /Upstox/);
  assert.equal(nifty26.from, '2026-01-01');
  assert.equal(nifty26.to, '2026-02-11'); // the last finished session, the 12th being before the close
  assert.equal(candlesOf(nifty26, 'NIFTY 50', '2026-01-05', '2026-01-05').length, 375);
  const listed = await files.list();
  assert.equal(listed.find((f) => f.name === 'nifty-2026.json.gz').days, 30);

  // second run: only the failed symbol is asked for again
  const calls = market.calls.length;
  market.provider.getCandlesBetween = async (symbol, _u, from, to) => {
    market.calls.push(`${symbol} ${from}..${to}`);
    return series(from, to);
  };
  dl.start({ months: 3 });
  assert.equal((await waitDone(dl)).state, 'done');
  assert.ok(market.calls.slice(calls).every((c) => c.startsWith('BBB')), market.calls.slice(calls).join('|'));
  assert.equal(market.calls.length - calls, 3);
});

test('a month Upstox refuses as too long is read in two windows', async () => {
  const dir = await tmp();
  const dl = new YearDownload({ market: fakeMarket({ reject400Over: 27 }), files: new YearFiles({ dir }), groups: [small[0]], now: at('2026-01-31T12:00:00Z') });
  dl.start({ months: 1 }); // January: 31 days
  assert.equal((await waitDone(dl)).state, 'done');
  const obj = await new YearFiles({ dir }).load('nifty', 2026);
  assert.equal(Object.keys(obj.symbols['NIFTY 50']).length, 22); // all of January's weekdays
});

test('the sample feed is refused', () => {
  const dl = new YearDownload({ market: { provider: { isSimulated: true } }, files: new YearFiles({ dir: '/x' }) });
  assert.throws(() => dl.start(), /sample feed/);
});

test('an imported file lives in the temporary folder, can be read, and deletes itself after its time', async () => {
  const dir = await tmp();
  const years = await tmp();
  const files = new YearFiles({ dir: years });
  const dl = new YearDownload({ market: fakeMarket(), files, groups: [small[0]], now: at('2026-02-12T12:00:00Z') });
  dl.start({ months: 1 });
  await waitDone(dl);
  const bytes = await readFile(path.join(years, 'nifty-2026.json.gz'));

  let clock = 1_000_000;
  const imports = new TempImports({ dir, ttlMs: 1000, now: () => clock });
  const { id, partPath } = await imports.begin();
  await writeFile(partPath, bytes);
  const meta = await imports.finish(id, partPath, 'nifty-2026.json.gz');
  assert.equal(meta.days, 9);
  assert.equal((await imports.list()).length, 1);
  assert.equal((await imports.candles(id, 'NIFTY 50', '2026-02-02', '2026-02-03')).length, 750);
  clock += 900; // reading gave it another second
  assert.equal((await imports.list()).length, 1);
  clock += 1100;
  assert.equal((await imports.list()).length, 0);
  assert.deepEqual(await readdir(dir), []);

  const bad = await imports.begin();
  await writeFile(bad.partPath, 'not a file of ours');
  await assert.rejects(imports.finish(bad.id, bad.partPath), /not a year file/);
  assert.deepEqual(await readdir(dir), []);
});

test('year routes: download list, file download, import by raw body, bad names refused', async () => {
  const years = await tmp();
  const files = new YearFiles({ dir: years });
  const market = fakeMarket();
  const yearDownload = new YearDownload({ market, files, groups: [small[0]], now: at('2026-02-12T12:00:00Z') });
  const imports = new TempImports({ dir: await tmp() });
  const optionArchive = new OptionArchive({ dir: await tmp(), mailer: new Mailer(), source: { months: async () => [], load: async () => [] }, state: { get: async () => ({ recipient: 'a@b.co', sent: [] }) } });
  const app = express();
  app.use(express.json());
  app.use('/api/year-data', yearDataRoutes({ yearDownload, yearFiles: files, imports, optionArchive, mailer: new Mailer() }));
  app.use(errorHandler);

  assert.equal((await request(app).post('/api/year-data/download').send({ months: 1 })).status, 202);
  await waitDone(yearDownload);
  const state = (await request(app).get('/api/year-data')).body;
  assert.equal(state.files[0].name, 'nifty-2026.json.gz');
  const got = await request(app).get('/api/year-data/files/nifty-2026.json.gz').buffer().parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
  assert.equal(got.status, 200);
  assert.equal(JSON.parse(gunzipSync(got.body)).format, 'nifty-candles-year-1');
  assert.equal((await request(app).get('/api/year-data/files/..%2Fsecret')).status, 400);

  const up = await request(app).post('/api/year-data/import?name=n.gz').set('Content-Type', 'application/octet-stream').send(got.body);
  assert.equal(up.status, 201);
  const c = await request(app).get(`/api/year-data/imports/${up.body.import.id}/candles?symbol=NIFTY%2050&from=2026-02-02&to=2026-02-02`);
  assert.equal(c.body.candles.length, 375);
  assert.equal((await request(app).post('/api/year-data/import').set('Content-Type', 'application/octet-stream').send(Buffer.from('junk'))).status, 400);
  assert.equal((await request(app).delete(`/api/year-data/imports/${up.body.import.id}`)).status, 200);
  assert.equal((await request(app).get('/api/year-data')).body.imports.length, 0);
});

// --- monthly option data ---
const row = (symbol, day, bytes = 100) => ({ symbol, day, expiry: '2026-10-27', strike: 24500, type: 'CE', lotSize: 65, n: 2, d: packOptionCandles([{ time: 1, open: 1, high: 2, low: 1, close: 2, volume: 5, oi: 9 }, { time: 61, open: 2, high: 3, low: 2, close: 3, volume: 6, oi: 9 }]).toString('base64'), bytes });

test('a month is cut into parts that keep each day whole', () => {
  const rows = [row('a', '2026-10-01', 60), row('b', '2026-10-01', 60), row('a', '2026-10-02', 60), row('a', '2026-10-03', 60)];
  const parts = splitParts(rows, 100);
  assert.deepEqual(parts.map((p) => p.map((r) => r.day)), [['2026-10-01', '2026-10-01'], ['2026-10-02', '2026-10-03']]);
  assert.equal(partName('2026-10', 1, 1), 'options-2026-10.json.gz');
  assert.equal(partName('2026-10', 2, 3), 'options-2026-10-part2of3.json.gz');
});

function archive({ mailer, rows = [row('NIFTY-20261027-24500-CE', '2026-10-05'), row('NIFTY-20261027-24500-CE', '2026-10-06')], now = at('2026-11-01T06:00:00Z'), partBytes } = {}) {
  const sent = [];
  const state = { recipient: 'sachingavali1920@gmail.com', sent };
  return {
    sent,
    state,
    arc: (dir) => new OptionArchive({ dir, mailer, now, partBytes, source: { months: async () => (rows.length ? ['2026-10'] : []), load: async (m) => rows.filter((r) => r.day.startsWith(m)) }, state: { get: async () => state, setRecipient: async (r) => { state.recipient = r; }, markSent: async (e) => { sent.push(e); } } }),
  };
}
const fakeMailer = () => {
  const mails = [];
  const m = new Mailer({ host: 'h', user: 'u', pass: 'p' }, () => ({ sendMail: async (x) => mails.push(x) }));
  m.mails = mails;
  return m;
};

test('the monthly job writes the file, emails it to the saved recipient once, and does not repeat', async () => {
  const mailer = fakeMailer();
  const { arc, sent } = archive({ mailer });
  const a = arc(await tmp());
  a.start('2026-10');
  assert.equal((await waitDone(a)).state, 'done');
  assert.equal(mailer.mails.length, 1);
  assert.equal(mailer.mails[0].to, 'sachingavali1920@gmail.com');
  assert.equal(mailer.mails[0].attachments[0].filename, 'options-2026-10.json.gz');
  const doc = JSON.parse(gunzipSync(await readFile(mailer.mails[0].attachments[0].path)));
  assert.equal(doc.format, 'nifty-option-candles-month-1');
  assert.equal(doc.complete, true);
  assert.equal(doc.contracts.length, 2);
  assert.equal(sent.length, 1);
  // sending the same finished month again skips parts already sent
  a.start('2026-10');
  await waitDone(a);
  assert.equal(mailer.mails.length, 1);
  const months = await a.months();
  assert.equal(months[0].sent.length, 1);
});

test('a big month is sent as several mails, each its own file', async () => {
  const mailer = fakeMailer();
  const rows = ['05', '06', '07'].map((d) => row('X', `2026-10-${d}`, 80));
  const { arc } = archive({ mailer, rows, partBytes: 100 });
  const a = arc(await tmp());
  a.start('2026-10');
  await waitDone(a);
  assert.deepEqual(mailer.mails.map((m) => m.subject), ['Nifty option data 2026-10 (part 1 of 2)', 'Nifty option data 2026-10 (part 2 of 2)']);
});

test('a finished month with a file is never rebuilt from what the database has left', async () => {
  const { arc } = archive({ mailer: new Mailer() });
  const dir = await tmp();
  const a = arc(dir);
  const first = await a.build('2026-10');
  const before = await readFile(path.join(dir, first[0]));
  a.source.load = async () => [];
  assert.deepEqual(await a.build('2026-10'), first);
  assert.deepEqual(await readFile(path.join(dir, first[0])), before);
});

test('without mail settings the file is still made, and an email request is refused', async () => {
  const { arc } = archive({ mailer: new Mailer() });
  const a = arc(await tmp());
  assert.throws(() => a.start('2026-10'), /not set up/);
  a.start('2026-10', { email: false });
  assert.equal((await waitDone(a)).state, 'done');
  assert.equal((await a.months())[0].files.length, 1);
});

test('the scheduled check sends last month once, only after the month has turned and the morning has begun', async () => {
  const mailer = fakeMailer();
  const early = archive({ mailer, now: at('2026-10-31T06:00:00Z') }); // still October: nothing to send
  const e = early.arc(await tmp());
  await e.check();
  assert.equal(e.status().state, 'idle');
  const { arc } = archive({ mailer });
  const a = arc(await tmp());
  await a.check();
  await waitDone(a);
  assert.equal(mailer.mails.length, 1);
  await a.check(); // already sent: nothing more
  assert.equal(a.status().state, 'done');
  assert.equal(mailer.mails.length, 1);
});

test('the scheduled check without mail settings only makes the file', async () => {
  const { arc } = archive({ mailer: new Mailer() });
  const a = arc(await tmp());
  await a.check();
  assert.equal((await a.months())[0].files.length, 1);
});
