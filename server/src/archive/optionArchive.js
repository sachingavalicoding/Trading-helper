import { mkdir, readdir, stat, writeFile, rename, rm } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { OptionCandleDay } from '../models/OptionCandleDay.js';
import { ArchiveState } from '../models/ArchiveState.js';
import { istParts } from '../market/marketHours.js';
import { conflict, badRequest } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const gz = promisify(gzip);

// The real option contract data the app saves each evening (Upstox 1-minute candles with open interest) is kept only 30 trading days in the
// database. Once a month the month just ended is written to compressed files and emailed, so it stays for deep study.

export const OPTION_FORMAT = 'nifty-option-candles-month-1';
export const OPTION_SOURCE = 'Upstox option contract candles (1-minute with open interest), saved by the app each evening for contracts near the money';
const PACKING = 'contracts[].d = base64 of a gzip of Int32 little-endian columns (time in epoch seconds, open, high, low, close in paise, volume, open interest); n rows, each column holds the change from the row before, column after column';
export const PART_BYTES = 12 * 1024 * 1024; // packed data per file: about 16 MB as mail, under the 25 MB limit of a message
const CHECK_EVERY_MS = 30 * 60000;
const TRIES_A_DAY = 3;
const SEND_FROM_MIN = 10 * 60;
export const DEFAULT_RECIPIENT = process.env.ARCHIVE_MAIL_TO || 'sachingavali1920@gmail.com';
const NAME_RE = /^options-\d{4}-\d{2}(-part\d+of\d+)?\.json\.gz$/;

const monthOf = (day) => day.slice(0, 7);
const prevMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};
export const partName = (month, part, parts) => (parts === 1 ? `options-${month}.json.gz` : `options-${month}-part${part}of${parts}.json.gz`);

/** The saved contracts, read from the database. (A test passes its own.) */
export const dbSource = {
  async months() {
    return [...new Set((await OptionCandleDay.distinct('day')).map(monthOf))].sort();
  },
  async load(month) {
    const docs = await OptionCandleDay.find({ day: { $gte: `${month}-01`, $lte: `${month}-31` } }).sort({ day: 1, symbol: 1 }).lean();
    return docs.map((d) => ({ symbol: d.symbol, day: d.day, expiry: d.expiry, strike: d.strike, type: d.type, lotSize: d.lotSize, n: d.count, d: Buffer.from(d.data.buffer ?? d.data).toString('base64'), bytes: (d.data.buffer ?? d.data).length }));
  },
};

export const dbState = {
  async get() {
    const s = await ArchiveState.findOne({ key: 'options' }).lean();
    return { recipient: s?.recipient || DEFAULT_RECIPIENT, sent: s?.sent ?? [] };
  },
  async setRecipient(recipient) {
    await ArchiveState.updateOne({ key: 'options' }, { $set: { recipient } }, { upsert: true });
  },
  async markSent(entry) {
    await ArchiveState.updateOne({ key: 'options' }, { $push: { sent: entry } }, { upsert: true });
  },
};

/** Cuts a month's contracts into parts of at most `limit` packed bytes, keeping each day whole. */
export function splitParts(rows, limit = PART_BYTES) {
  const parts = [[]];
  let size = 0;
  let day = null;
  for (const r of rows) {
    if (r.day !== day && size >= limit) {
      parts.push([]);
      size = 0;
    }
    day = r.day;
    parts.at(-1).push(r);
    size += r.bytes;
  }
  return parts;
}

export class OptionArchive {
  constructor({ dir, mailer, source = dbSource, state = dbState, now = () => new Date(), partBytes = PART_BYTES }) {
    this.dir = dir;
    this.mailer = mailer;
    this.source = source;
    this.state = state;
    this.now = now;
    this.partBytes = partBytes;
    this.job = { state: 'idle' };
    this.tries = new Map();
    this.timer = null;
  }

  status() {
    return this.job;
  }

  pathOf(name) {
    if (!NAME_RE.test(name)) throw badRequest('Not an option data file name');
    return path.join(this.dir, name);
  }

  /** Files already written for a month, by name. */
  async filesOf(month) {
    try {
      return (await readdir(this.dir)).filter((n) => NAME_RE.test(n) && (n.startsWith(`options-${month}.`) || n.startsWith(`options-${month}-part`))).sort();
    } catch {
      return [];
    }
  }

  /**
   * Writes a month's file(s) from the database. A finished month that already has files keeps them (the database forgets old days, so rebuilding
   * could only lose data); the running month is rebuilt each time. Returns the file names, or [] when there is no data for the month.
   */
  async build(month) {
    const current = month === monthOf(istParts(this.now()).dateKey);
    const have = await this.filesOf(month);
    if (have.length && !current) return have;
    const rows = await this.source.load(month);
    if (!rows.length) return have;
    const parts = splitParts(rows, this.partBytes);
    await mkdir(this.dir, { recursive: true });
    const names = [];
    for (const [i, list] of parts.entries()) {
      const days = [...new Set(list.map((r) => r.day))];
      const doc = {
        format: OPTION_FORMAT,
        source: OPTION_SOURCE,
        index: 'NIFTY',
        month,
        part: i + 1,
        parts: parts.length,
        from: days[0],
        to: days.at(-1),
        days: days.length,
        complete: !current,
        packing: PACKING,
        createdAt: new Date().toISOString(),
        contracts: list.map(({ bytes, ...r }) => r),
      };
      const name = partName(month, i + 1, parts.length);
      const tmp = `${this.pathOf(name)}.tmp`;
      await writeFile(tmp, await gz(Buffer.from(JSON.stringify(doc))));
      await rename(tmp, this.pathOf(name));
      names.push(name);
    }
    for (const old of have) if (!names.includes(old)) await rm(this.pathOf(old), { force: true });
    return names;
  }

  /** Emails the files of a month that were not sent to this recipient yet. Returns the names sent. */
  async mail(month, names) {
    const { recipient, sent } = await this.state.get();
    const sentTo = new Set(sent.filter((s) => s.month === month && s.to === recipient).map((s) => s.part));
    const done = [];
    for (const [i, name] of names.entries()) {
      if (sentTo.has(i + 1) && month !== monthOf(istParts(this.now()).dateKey)) continue;
      await this.mailer.send({
        to: recipient,
        subject: `Nifty option data ${month}${names.length > 1 ? ` (part ${i + 1} of ${names.length})` : ''}`,
        text: `Real Upstox option contract data saved by the paper trader for ${month}. 1-minute candles with open interest for the contracts near the money. The file is a gzip of JSON; its "packing" line says how to read the candles. It can be imported in the app (Research > Data) or kept for study.`,
        attachments: [{ filename: name, path: this.pathOf(name) }],
      });
      await this.state.markSent({ month, part: i + 1, to: recipient, at: new Date() });
      done.push(name);
    }
    return done;
  }

  /** Builds a month's files and, with `email`, sends them. Runs in the background; poll status(). */
  start(month, { email = true } = {}) {
    if (this.job.state === 'running') throw conflict('Already working on a month');
    if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Give the month as YYYY-MM');
    if (email && !this.mailer.enabled) throw badRequest('Email is not set up on the server yet. The file can still be made and downloaded.', 'NO_MAIL');
    const job = { state: 'running', month, step: 'Making the file', startedAt: Date.now() };
    this.job = job;
    (async () => {
      const names = await this.build(month);
      if (!names.length) throw new Error(`No option data saved for ${month}`);
      job.files = names;
      if (email) {
        job.step = 'Sending the email';
        job.sent = await this.mail(month, names);
      }
    })()
      .then(() => Object.assign(job, { state: 'done', step: '', finishedAt: Date.now() }))
      .catch((e) => {
        logger.warn(`Option data archive ${month} failed: ${e.message}`);
        Object.assign(job, { state: 'failed', error: e.message, finishedAt: Date.now() });
      });
    return job;
  }

  /** The months with option data (in the database or as files), each with its files, size and what was emailed. */
  async months() {
    const [saved, state] = await Promise.all([this.source.months(), this.state.get()]);
    let names = [];
    try {
      names = (await readdir(this.dir)).filter((n) => NAME_RE.test(n));
    } catch {
      /* no folder yet */
    }
    const all = [...new Set([...saved, ...names.map((n) => n.slice(8, 15))])].sort().reverse();
    return Promise.all(
      all.map(async (month) => {
        const files = await Promise.all(names.filter((n) => n.startsWith(`options-${month}.`) || n.startsWith(`options-${month}-part`)).sort().map(async (name) => ({ name, bytes: (await stat(this.pathOf(name))).size })));
        return { month, inDatabase: saved.includes(month), files, sent: state.sent.filter((s) => s.month === month) };
      }),
    );
  }

  /** Every 30 minutes: on any day of a month after the first morning, build and email the month before if it has data and was not sent yet. */
  async check() {
    try {
      if (this.job.state === 'running') return;
      const { dateKey, minutes } = istParts(this.now());
      if (minutes < SEND_FROM_MIN) return;
      const month = prevMonth(monthOf(dateKey));
      const key = `${dateKey}${month}`;
      if ((this.tries.get(key) ?? 0) >= TRIES_A_DAY) return;
      if (!(await this.source.months()).includes(month) && !(await this.filesOf(month)).length) return;
      const { recipient, sent } = await this.state.get();
      const names = await this.filesOf(month);
      const sentAll = names.length > 0 && names.every((_, i) => sent.some((s) => s.month === month && s.part === i + 1 && s.to === recipient));
      if (sentAll) return;
      this.tries.set(key, (this.tries.get(key) ?? 0) + 1);
      if (!this.mailer.enabled) {
        if (!names.length) await this.build(month); // the file is made even without email, so it can be downloaded
        return;
      }
      this.start(month, { email: true });
    } catch (e) {
      logger.warn(`Option data archive check failed: ${e.message}`);
    }
  }

  schedule() {
    const tick = () => this.check();
    this.timer = setInterval(tick, CHECK_EVERY_MS);
    this.timer.unref?.();
    setTimeout(tick, 120000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }
}
