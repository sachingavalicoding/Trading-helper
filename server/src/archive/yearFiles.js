import { mkdir, readFile, writeFile, rename, readdir, stat, rm } from 'node:fs/promises';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { packCandles, unpackCandles } from '../market/historyStore.js';
import { istParts } from '../market/marketHours.js';
import { addDays } from '../market/days.js';
import { NIFTY50 } from '../market/instruments.js';
import { UNDERLYING } from '../options/symbols.js';
import { windowsBack } from '../market/historySync.js';
import { conflict, badRequest, notFound } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const gz = promisify(gzip);
const gunz = promisify(gunzip);

// Years of 1-minute candles kept as compressed files, one per group and calendar year (nifty-2025.json.gz, shares-2025.json.gz), never in the database.
// A file can be downloaded to a phone or laptop and loaded back later (Import) for a test, which keeps it for a day in a temporary folder.

export const YEAR_FORMAT = 'nifty-candles-year-1';
export const GROUPS = {
  nifty: { key: 'nifty', label: 'Nifty', symbols: [UNDERLYING] },
  shares: { key: 'shares', label: 'The 50 Nifty shares', symbols: NIFTY50.map((s) => s.symbol) },
};
export const SOURCE = 'Upstox historical candle API (V3), 1-minute candles, NSE';
const PACKING = 'symbols[SYMBOL][YYYY-MM-DD] = { n: number of candles, d: base64 of a gzip of Int32 little-endian columns (time in epoch seconds, open, high, low, close in paise, volume); each column holds the change from the row before, column after column }';
const NAME_RE = /^(nifty|shares)-(\d{4})\.json\.gz$/;
export const MAX_IMPORT_BYTES = 400 * 1024 * 1024;
export const IMPORT_TTL_MS = 24 * 3600 * 1000;

export const fileName = (group, year) => `${group}-${year}.json.gz`;
export const monthEnd = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);

/** The calendar months (YYYY-MM) from `count` months before the month of `lastDay` up to it, oldest first. */
export function monthsBack(lastDay, count) {
  let [y, m] = lastDay.split('-').map(Number);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`);
    if (--m === 0) [y, m] = [y - 1, 12];
  }
  return out;
}

const emptyYear = (group, year) => ({ format: YEAR_FORMAT, source: SOURCE, interval: '1m', group, year, packing: PACKING, createdAt: new Date().toISOString(), updatedAt: null, from: null, to: null, covered: {}, symbols: {} });

/** What a year object holds: the first and last day, the number of days and symbols. */
export function summarize(obj) {
  let from = null;
  let to = null;
  const days = new Set();
  for (const byDay of Object.values(obj.symbols || {})) {
    for (const d of Object.keys(byDay)) {
      days.add(d);
      if (!from || d < from) from = d;
      if (!to || d > to) to = d;
    }
  }
  return { group: obj.group, year: obj.year, source: obj.source, from, to, days: days.size, symbols: Object.keys(obj.symbols || {}).length };
}

/** Candles of one symbol from `from` to `to` (YYYY-MM-DD) out of a year object, oldest first. */
export function candlesOf(obj, symbol, from, to) {
  const byDay = obj.symbols?.[symbol] || {};
  return Object.keys(byDay)
    .filter((d) => d >= from && d <= to)
    .sort()
    .flatMap((d) => unpackCandles(Buffer.from(byDay[d].d, 'base64'), byDay[d].n));
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** The year files in a folder. */
export class YearFiles {
  constructor({ dir }) {
    this.dir = dir;
  }

  /** The full path of a year file by its name; throws unless it is one of ours (no folders, no odd names). */
  pathOf(name) {
    if (!NAME_RE.test(name)) throw badRequest('Not a year file name');
    return path.join(this.dir, name);
  }

  async load(group, year) {
    try {
      return JSON.parse((await gunz(await readFile(this.pathOf(fileName(group, year))))).toString());
    } catch (e) {
      if (e.code === 'ENOENT') return emptyYear(group, year);
      throw e;
    }
  }

  async save(obj) {
    await mkdir(this.dir, { recursive: true });
    obj.updatedAt = new Date().toISOString();
    Object.assign(obj, { from: summarize(obj).from, to: summarize(obj).to });
    const name = fileName(obj.group, obj.year);
    await writeAtomic(this.pathOf(name), await gz(Buffer.from(JSON.stringify(obj))));
    await writeAtomic(`${this.pathOf(name)}.meta.json`, JSON.stringify(summarize(obj)));
  }

  async list() {
    let names = [];
    try {
      names = (await readdir(this.dir)).filter((n) => NAME_RE.test(n)).sort();
    } catch {
      return [];
    }
    return Promise.all(
      names.map(async (name) => {
        const meta = await readFile(`${this.pathOf(name)}.meta.json`, 'utf8').then(JSON.parse).catch(() => ({}));
        return { name, bytes: (await stat(this.pathOf(name))).size, ...meta };
      }),
    );
  }
}

/** Downloads the 1-minute candles month by month into the year files. Resumable: a symbol-month already covered is never asked for again. */
export class YearDownload {
  constructor({ market, files, now = () => new Date(), groups = Object.values(GROUPS) }) {
    this.market = market;
    this.files = files;
    this.now = now;
    this.groups = groups;
    this.job = { state: 'idle' };
    this.halves = false;
  }

  status() {
    return this.job;
  }

  lastCompleteDay() {
    const { minutes, dateKey } = istParts(this.now());
    return minutes >= 15 * 60 + 35 ? dateKey : addDays(dateKey, -1);
  }

  start({ months = 12 } = {}) {
    if (this.job.state === 'running') throw conflict('The download is already running');
    if (this.market.provider.isSimulated) throw badRequest('The sample feed has no real history. Log in to Upstox first.', 'NO_HISTORY');
    const list = monthsBack(this.lastCompleteDay(), months);
    const total = list.length * this.groups.reduce((n, g) => n + g.symbols.length, 0);
    const job = { state: 'running', step: 'Starting', done: 0, total, failed: [], months: [list[0], list.at(-1)], startedAt: Date.now() };
    this.job = job;
    this.#run(job, list)
      .then(() => Object.assign(job, { state: job.failed.length ? 'partial' : 'done', step: '', finishedAt: Date.now() }))
      .catch((e) => {
        logger.warn(`Year download failed: ${e.message}`);
        Object.assign(job, { state: 'failed', error: e.message, finishedAt: Date.now() });
      });
    return job;
  }

  async #run(job, months) {
    const last = this.lastCompleteDay();
    for (const group of this.groups) {
      const open = new Map(); // year -> year object, kept while its months are read
      for (const month of months) {
        const start = `${month}-01`;
        const target = monthEnd(month) < last ? monthEnd(month) : last;
        if (target < start) {
          job.done += group.symbols.length;
          continue;
        }
        const year = Number(month.slice(0, 4));
        if (!open.has(year)) open.set(year, await this.files.load(group.key, year));
        const obj = open.get(year);
        let touched = false;
        for (const symbol of group.symbols) {
          job.step = `${group.label}, ${month}, ${symbol}`;
          if ((obj.covered[symbol]?.[month] ?? '') >= target) {
            job.done++;
            continue;
          }
          try {
            const candles = await this.#read(symbol, start, target);
            const days = new Map();
            for (const c of candles) {
              const d = istParts(new Date(c.time * 1000)).dateKey;
              if (d >= start && d <= target) days.set(d, [...(days.get(d) ?? []), c]);
            }
            obj.symbols[symbol] ??= {};
            for (const [d, list] of days) obj.symbols[symbol][d] = { n: list.length, d: packCandles(list).toString('base64') };
            obj.covered[symbol] = { ...obj.covered[symbol], [month]: target };
            touched = true;
          } catch (e) {
            job.failed.push({ symbol: `${symbol} ${month}`, error: String(e.message).slice(0, 120) });
            logger.warn(`Year download: ${symbol} ${month} stopped: ${e.message}`);
            if (job.failed.length >= 5 && job.done === 0) throw new Error(`Upstox keeps refusing: ${e.message}`);
          }
          job.done++;
        }
        if (touched) await this.files.save(obj); // a stop after this point loses nothing
      }
    }
  }

  /** One symbol's month: in one request, or in two when Upstox has refused a whole month (400) once. */
  async #read(symbol, start, end) {
    const provider = this.market.provider;
    if (!this.halves) {
      try {
        return await provider.getCandlesBetween(symbol, 1, start, end);
      } catch (e) {
        if (!String(e.message).startsWith('HTTP 400')) throw e;
        this.halves = true;
      }
    }
    const out = [];
    for (const w of windowsBack(start, end).reverse()) out.push(...(await provider.getCandlesBetween(symbol, 1, w.from, w.to)));
    return out;
  }
}

/** Year files loaded back for a test: kept in a temporary folder of their own, away from trading data, and deleted by themselves a day after their last use. */
export class TempImports {
  constructor({ dir, ttlMs = IMPORT_TTL_MS, now = () => Date.now() }) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.now = now;
    this.cached = null; // { id, obj }
    this.timer = null;
  }

  #file(id) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw notFound('No such import');
    return path.join(this.dir, id);
  }

  /** Where an upload is written; `finish` validates it and registers it. */
  async begin() {
    await mkdir(this.dir, { recursive: true });
    const id = randomBytes(8).toString('hex');
    return { id, partPath: `${this.#file(id)}.part` };
  }

  async finish(id, partPath, name = '') {
    try {
      const obj = JSON.parse((await gunz(await readFile(partPath))).toString());
      if (obj?.format !== YEAR_FORMAT || typeof obj.symbols !== 'object') throw new Error('bad');
      await rename(partPath, `${this.#file(id)}.json.gz`);
      const meta = { id, name: String(name).slice(0, 80), ...summarize(obj), importedAt: this.now(), expiresAt: this.now() + this.ttlMs };
      await writeFile(`${this.#file(id)}.json`, JSON.stringify(meta));
      this.cached = { id, obj };
      return meta;
    } catch {
      await rm(partPath, { force: true });
      throw badRequest('This is not a year file made by this app', 'BAD_FILE');
    }
  }

  async list() {
    await this.sweep();
    let names = [];
    try {
      names = (await readdir(this.dir)).filter((n) => /^[a-f0-9]{16}\.json$/.test(n));
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) out.push(JSON.parse(await readFile(path.join(this.dir, n), 'utf8')));
    return out.sort((a, b) => b.importedAt - a.importedAt);
  }

  async remove(id) {
    const base = this.#file(id);
    await Promise.all([rm(`${base}.json.gz`, { force: true }), rm(`${base}.json`, { force: true }), rm(`${base}.part`, { force: true })]);
    if (this.cached?.id === id) this.cached = null;
  }

  /** Deletes imports whose time is up, and upload leftovers. Returns how many imports went. */
  async sweep() {
    let names = [];
    try {
      names = await readdir(this.dir);
    } catch {
      return 0;
    }
    let gone = 0;
    for (const n of names) {
      const id = /^([a-f0-9]{16})\.json$/.exec(n)?.[1];
      if (id) {
        const meta = JSON.parse(await readFile(path.join(this.dir, n), 'utf8').catch(() => '{}'));
        if (!(meta.expiresAt > this.now())) {
          await this.remove(id);
          gone++;
        }
      } else if (n.endsWith('.part')) {
        const age = this.now() - (await stat(path.join(this.dir, n)).catch(() => ({ mtimeMs: this.now() }))).mtimeMs;
        if (age > 3600000) await rm(path.join(this.dir, n), { force: true });
      }
    }
    return gone;
  }

  async #load(id) {
    if (this.cached?.id === id) return this.cached.obj;
    const obj = JSON.parse((await gunz(await readFile(`${this.#file(id)}.json.gz`).catch(() => { throw notFound('No such import (it may have expired)'); }))).toString());
    this.cached = { id, obj };
    return obj;
  }

  /** The imported candles of one symbol between two days, oldest first. Each read gives the import another day. */
  async candles(id, symbol, from, to) {
    const obj = await this.#load(id);
    const metaFile = `${this.#file(id)}.json`;
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    await writeFile(metaFile, JSON.stringify({ ...meta, expiresAt: this.now() + this.ttlMs }));
    return candlesOf(obj, symbol, from, to);
  }

  schedule() {
    this.sweep().catch(() => {});
    this.timer = setInterval(() => this.sweep().catch(() => {}), 30 * 60000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
