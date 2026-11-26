import mongoose from 'mongoose';
import { AutoSettings, OptionSettings, TradeDefaults, LearnerState } from '../models/index.js';
import { normalizeCombos, MAX_COMBOS } from '../combos/combos.js';

// More > Settings > Copy settings: one file (or code) with every setting of a login, so another login (a brother's app) can use the
// same options bot, shares bot, exit rules, combinations and learner switches. Import REPLACES the settings of the login that
// imports it. Never in the file: the login itself, tokens and keys, trades, orders, positions, money (wallet) and P&L.

export const FORMAT = 'trade-helper-settings';
export const VERSION = 1;

// The saved setting documents, by section name in the file.
const MODELS = { options: OptionSettings, shares: AutoSettings, rules: TradeDefaults };
const LEARNER_SWITCHES = { options: 'auto', shares: 'auto', tune: 'evening' };
const SECTION_NAMES = { options: 'Options bot', shares: 'Shares bot', rules: 'Stop, profit lock, close time', learner: 'Learner switches' };

// Not settings: who owns the document, Mongo's own fields, and "pause today", which is a date on the sending login's calendar.
const DROP = new Set(['_id', '__v', 'user', 'createdAt', 'updatedAt', 'pausedOn']);

/** The real settings fields of a model (top level), so a file's unknown keys can be named and left out. */
const fieldsOf = (Model) => new Set(Object.keys(Model.schema.paths).map((p) => p.split('.')[0]).filter((k) => !DROP.has(k)));

/** A saved document (or a fresh one with the defaults when nothing is saved yet) as plain settings, without the owner or Mongo fields. */
function plain(Model, doc) {
  const obj = doc ? new Model(doc).toObject({ depopulate: true }) : new Model({}).toObject();
  const out = {};
  for (const k of fieldsOf(Model)) if (obj[k] !== undefined) out[k] = JSON.parse(JSON.stringify(obj[k]));
  return out;
}

const withCombos = (o) => ({ ...o, combos: normalizeCombos(o.combos ?? []) });

/** Everything the file holds for a login, read from the database. */
export async function exportSettings(userId) {
  const [o, a, t, learners] = await Promise.all([
    OptionSettings.findOne({ user: userId }).lean(),
    AutoSettings.findOne({ user: userId }).lean(),
    TradeDefaults.findOne({ user: userId }).lean(),
    LearnerState.find({ user: userId }, 'kind auto evening').lean(),
  ]);
  return buildExport({ options: o, shares: a, rules: t, learners });
}

/** The file from the saved documents (any may be null: then its defaults are written). */
export function buildExport({ options, shares, rules, learners = [], now = new Date() }) {
  const learner = {};
  for (const [kind, key] of Object.entries(LEARNER_SWITCHES)) learner[kind] = { [key]: learners.find((l) => l.kind === kind)?.[key] === true };
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: now.toISOString(),
    note: 'Trade Helper settings. Importing this file replaces all settings and combinations of the login that imports it. No login, keys, trades or P&L are in it.',
    options: withCombos(plain(OptionSettings, options)),
    shares: withCombos(plain(AutoSettings, shares)),
    rules: plain(TradeDefaults, rules),
    learner,
  };
}

export class ImportError extends Error {}

/**
 * Checks a file and turns it into the documents to save. Throws ImportError with a plain message for a file that is not one of ours,
 * from a newer app, or has a value the settings cannot take. Unknown keys are left out and named in `ignored`.
 */
export function readImport(file) {
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new ImportError('This is not a settings file.');
  if (file.format !== FORMAT) throw new ImportError('This is not a Trade Helper settings file.');
  if (!Number.isInteger(file.version) || file.version < 1) throw new ImportError('The settings file has no valid version.');
  if (file.version > VERSION) throw new ImportError(`This file was made by a newer version of the app (version ${file.version}). Update this app first.`);
  const ignored = [];
  const known = new Set(['format', 'version', 'exportedAt', 'note', 'device', ...Object.keys(MODELS), 'learner']);
  for (const k of Object.keys(file)) if (!known.has(k)) ignored.push(k);
  if (!Object.keys(MODELS).some((k) => file[k] && typeof file[k] === 'object')) throw new ImportError('The settings file has no settings in it.');

  const docs = {};
  for (const [section, Model] of Object.entries(MODELS)) {
    const raw = file[section] ?? {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new ImportError(`${SECTION_NAMES[section]}: the settings are damaged.`);
    const fields = fieldsOf(Model);
    const clean = {};
    for (const [k, v] of Object.entries(raw)) {
      if (fields.has(k)) clean[k] = v;
      else if (!DROP.has(k)) ignored.push(`${section}.${k}`);
    }
    if (Array.isArray(clean.combos)) {
      const kept = normalizeCombos(clean.combos);
      // a combination whose checks this app does not know is left out (normalizeCombos drops it); name it so nothing goes quietly
      for (const c of clean.combos.slice(0, MAX_COMBOS)) if (!kept.some((k) => k.name === String(c?.name ?? '').trim().slice(0, 60))) ignored.push(`${section}.combos: ${String(c?.name ?? 'unnamed').slice(0, 60)}`);
      clean.combos = kept;
    }
    else if (clean.combos !== undefined) throw new ImportError(`${SECTION_NAMES[section]}: the combinations are damaged.`);
    const doc = new Model({ ...clean, user: new mongoose.Types.ObjectId() }); // a stand-in owner, only so the check can run
    const err = doc.validateSync();
    if (err) {
      const first = Object.values(err.errors)[0];
      throw new ImportError(`${SECTION_NAMES[section]}: "${first?.path}" has a value this app cannot use (${first?.value ?? 'empty'}).`);
    }
    docs[section] = plain(Model, doc.toObject());
  }
  if (docs.options.entryFrom >= docs.options.entryTo || docs.shares.entryFrom >= docs.shares.entryTo) throw new ImportError('The trading hours in the file are not valid (the start is not before the end).');

  const learner = {};
  const rawLearner = file.learner && typeof file.learner === 'object' ? file.learner : {};
  for (const [kind, key] of Object.entries(LEARNER_SWITCHES)) learner[kind] = { [key]: rawLearner[kind]?.[key] === true };
  return { docs, learner, ignored };
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const short = (v) => {
  if (v === undefined || v === null) return '-';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (Array.isArray(v)) return v.length ? (v.every((x) => typeof x !== 'object') ? v.join(', ') : `${v.length} rows`) : 'none';
  if (typeof v === 'object') return 'changed';
  return String(v);
};

/** What changes for each combination list: names added, removed and changed. */
function comboChanges(cur = [], next = []) {
  const byId = new Map(cur.map((c) => [c.id, c]));
  const nextIds = new Set(next.map((c) => c.id));
  return {
    count: next.length,
    on: next.filter((c) => c.on).length,
    added: next.filter((c) => !byId.has(c.id)).map((c) => c.name),
    removed: cur.filter((c) => !nextIds.has(c.id)).map((c) => c.name),
    changed: next.filter((c) => byId.has(c.id) && !same(c, byId.get(c.id))).map((c) => c.name),
  };
}

/** The summary shown before the import: per section, each setting that changes (from, to), and the combinations added, removed and changed. */
export async function previewImport(userId, file) {
  const read = readImport(file);
  return diffSettings(await exportSettings(userId), read, file);
}

/** The summary itself, from the current settings (as exportSettings gives them) and a checked file (readImport). */
export function diffSettings(current, read, file) {
  const sections = [];
  for (const section of [...Object.keys(MODELS), 'learner']) {
    const cur = current[section];
    const next = section === 'learner' ? read.learner : read.docs[section];
    const changes = [];
    // one level down for grouped settings (share entry rules, the stop and lock of each segment, the learner switches)
    const flat = (obj) => Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v).map(([k2, v2]) => [`${k}.${k2}`, v2]) : [[k, v]]));
    const curFlat = new Map(flat(cur));
    for (const [k, v] of flat(next)) {
      if (k === 'combos') continue;
      if (!same(curFlat.get(k), v)) changes.push({ key: k, from: short(curFlat.get(k)), to: short(v) });
    }
    const combos = section in MODELS && section !== 'rules' ? comboChanges(cur.combos, next.combos) : undefined;
    sections.push({ key: section, name: SECTION_NAMES[section], changes, combos });
  }
  const total = sections.reduce((n, s) => n + s.changes.length + (s.combos ? s.combos.added.length + s.combos.removed.length + s.combos.changed.length : 0), 0);
  return { exportedAt: typeof file.exportedAt === 'string' ? file.exportedAt : null, version: file.version, sections, total, ignored: read.ignored };
}

/** Replaces every setting of the login with the file's (fields not in the file go back to their defaults). */
export async function applyImport(userId, file) {
  const read = readImport(file);
  for (const [section, Model] of Object.entries(MODELS)) {
    const doc = new Model({ ...read.docs[section], user: userId }).toObject();
    delete doc._id;
    // keep "pause today" of this login: it is not a setting that travels
    const keep = section === 'options' ? (await OptionSettings.findOne({ user: userId }, 'pausedOn').lean())?.pausedOn : undefined;
    if (keep) doc.pausedOn = keep;
    await Model.replaceOne({ user: userId }, doc, { upsert: true, runValidators: true });
  }
  for (const [kind, sw] of Object.entries(read.learner)) {
    await LearnerState.updateOne({ user: userId, kind }, { $set: sw, $setOnInsert: { user: userId, kind } }, { upsert: true });
  }
  return { ok: true, ignored: read.ignored };
}
