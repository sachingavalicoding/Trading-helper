import { TickChunk } from '../models/TickChunk.js';
import { CandleDay } from '../models/CandleDay.js';
import { OptionCandleDay } from '../models/OptionCandleDay.js';
import { OptionSettings } from '../models/OptionSettings.js';
import { AutoSettings } from '../models/AutoSettings.js';
import { AutoLog } from '../models/AutoLog.js';
import { NIFTY50 } from '../market/instruments.js';
import { chooseExpiry, parseOptionSymbol, UNDERLYING } from '../options/symbols.js';
import { entryModes } from '../options/optionTrader.js';
import { normalizeCombos } from '../combos/combos.js';
import { addDays } from '../market/days.js';

// Plain-words reasons why a replay does or does not trade. Two views: the data check (before starting: what the chosen day lacks) and
// "Why no trades" (while it runs: what the bots see right now). Both return a list of { level: 'bad' | 'warn' | 'ok', text }.

const MIN_NIFTY_BARS = 60; // the options chart read needs this many 1-minute candles (options/signal.js)
const MIN_SHARE_BARS = 100; // a share combination needs this many (auto/autoTrader.js)
const PRIOR_DAYS = 12;
const mmm = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const item = (level, text) => ({ level, text });

/** Which of the user's settings let the bots buy at all. */
export function settingsItems({ optionSettings, autoSettings }) {
  const out = [];
  const o = optionSettings;
  if (!o?.enabled) out.push(item('bad', 'Auto options is OFF (Account > Entries). The replay copies your settings, so the options bot will not buy.'));
  else {
    const modes = entryModes(o);
    if (!modes.score && !modes.patterns.length && !modes.combos) out.push(item('bad', 'Auto options is on, but no way to buy is switched on: no Indicator score, no pattern, and no combination that is ON.'));
    else {
      const ways = [modes.score && 'Indicator score', modes.patterns.length && `${modes.patterns.length} pattern(s)`, modes.combos && `${normalizeCombos(o.combos).filter((c) => c.on).length} combination(s)`].filter(Boolean);
      out.push(item('ok', `Auto options is on and buys on: ${ways.join(', ')}.`));
    }
    if (o.pausedOn) out.push(item('warn', `Options buying is paused for ${o.pausedOn}. A replay day is a different date, so this should not matter.`));
  }
  const a = autoSettings;
  if (!a?.enabled) out.push(item('warn', 'Auto shares is OFF (Account > Entries), so no share will be bought.'));
  else {
    const n = normalizeCombos(a.combos).filter((c) => c.on).length;
    out.push(item('ok', `Auto shares is on and buys scanner ideas of score ${a.minScore ?? 70}+ that pass your entry rules${n ? `, plus ${n} combination(s)` : ''}.`));
  }
  return out;
}

/** The data check of a day from plain facts (see gatherCheckFacts). */
export function checkItems(f) {
  const out = [];
  if (!f.niftySeconds) out.push(item('bad', `No recorded seconds of the Nifty for ${mmm(f.day)}. The replay cannot run.`));
  else out.push(item('ok', `Nifty: ${f.niftySeconds.toLocaleString('en-IN')} recorded seconds for ${mmm(f.day)}.`));

  if (f.niftyPriorBars < MIN_NIFTY_BARS) {
    out.push(item('bad', `Nifty has only ${f.niftyPriorBars} saved 1-minute candles before ${mmm(f.day)} (the options bot needs ${MIN_NIFTY_BARS}). It cannot read the chart until about 10:15 on the replay clock. Press Download in Account > Studies > Data.`));
  } else out.push(item('ok', `Nifty history: ${f.niftyPriorBars} candles from ${f.niftyPriorDays} earlier day(s).`));

  const priced = f.expiries.filter((e) => e.contracts > 0);
  if (!priced.length) out.push(item('bad', `No option prices were saved for ${mmm(f.day)}: no recorded seconds and no 1-minute candles of any strike. No option can be bought. Candles of a day are saved in the evening, so a day that is not finished yet may have none.`));
  else {
    if (f.chosenExpiry) {
      const e = f.expiries.find((x) => x.expiry === f.chosenExpiry);
      if (!e?.contracts) out.push(item('bad', `The options bot would buy the ${mmm(f.chosenExpiry)} expiry on ${mmm(f.day)} (it skips a contract that expires that day), but no prices were saved for it. Saved expiries: ${priced.map((x) => mmm(x.expiry)).join(', ')}.`));
      else out.push(item('ok', `Options: the bot would buy the ${mmm(f.chosenExpiry)} expiry; ${e.contracts} of its strikes have prices (${f.optionTickContracts} streamed each second, ${f.optionCandleContracts} with 1-minute candles).`));
    } else out.push(item('bad', 'No expiry date is available for that day.'));
  }

  if (f.sharesWithHistory < 20) out.push(item('warn', `Shares: only ${f.sharesWithHistory} of 50 have the ${MIN_SHARE_BARS} earlier 1-minute candles the share combinations need. Press Download in Account > Studies > Data.`));
  else out.push(item('ok', `Shares: ${f.sharesWithHistory} of 50 have enough earlier candles.`));
  if (f.sharesOnDay < 20) out.push(item('warn', `Shares: only ${f.sharesOnDay} of 50 have 1-minute candles saved for ${mmm(f.day)}, so most shares will not move in the replay.`));
  else out.push(item('ok', `Shares: ${f.sharesOnDay} of 50 have candles for ${mmm(f.day)} (they move once a minute).`));

  return [...out, ...settingsItems(f)];
}

/** Reads what the check needs from the database (the live server's, or the replay copy's). */
export async function gatherCheckFacts({ day, userId }) {
  const from = addDays(day, -PRIOR_DAYS);
  const shareSymbols = NIFTY50.map((s) => s.symbol);
  const [nifty, tickSyms, candleDocs, prior, shareDay, optionSettings, autoSettings] = await Promise.all([
    TickChunk.aggregate([{ $match: { symbol: UNDERLYING, day } }, { $group: { _id: null, n: { $sum: '$count' } } }]),
    TickChunk.distinct('symbol', { day }),
    OptionCandleDay.find({ day }, 'symbol').lean(),
    CandleDay.aggregate([{ $match: { day: { $gte: from, $lt: day } } }, { $group: { _id: '$symbol', bars: { $sum: '$count' }, days: { $sum: 1 } } }]),
    CandleDay.distinct('symbol', { day }),
    OptionSettings.findOne({ user: userId }).lean(),
    AutoSettings.findOne({ user: userId }).lean(),
  ]);
  const byExpiry = new Map();
  const tickOpts = tickSyms.filter((s) => parseOptionSymbol(s));
  for (const symbol of new Set([...tickOpts, ...candleDocs.map((d) => d.symbol)])) {
    const o = parseOptionSymbol(symbol);
    if (o) byExpiry.set(o.expiry, (byExpiry.get(o.expiry) ?? 0) + 1);
  }
  const expiries = [...byExpiry].map(([expiry, contracts]) => ({ expiry, contracts })).sort((a, b) => a.expiry.localeCompare(b.expiry));
  const nifty1 = prior.find((p) => p._id === UNDERLYING);
  return {
    day,
    niftySeconds: nifty[0]?.n ?? 0,
    niftyPriorBars: nifty1?.bars ?? 0,
    niftyPriorDays: nifty1?.days ?? 0,
    expiries,
    chosenExpiry: chooseExpiry(expiries.map((e) => e.expiry).filter((e) => e >= day), new Date(`${day}T04:30:00Z`), { minDays: 1 }),
    optionTickContracts: tickOpts.length,
    optionCandleContracts: candleDocs.length,
    sharesWithHistory: prior.filter((p) => shareSymbols.includes(p._id) && p.bars >= MIN_SHARE_BARS).length,
    sharesOnDay: shareDay.filter((s) => shareSymbols.includes(s)).length,
    optionSettings,
    autoSettings,
  };
}

/** "Why no trades" from what the running replay sees right now (see gatherWhyFacts). */
export function whyItems(f) {
  const out = [];
  const o = f.optionSettings;
  const when = `${f.dateText ? `${f.dateText} ` : ''}${f.clockText}`;
  out.push(f.marketOpen ? item('ok', `Replay clock ${when} IST: market open.`) : item('bad', `Replay clock ${when} IST: the market is closed, so nothing is bought.`));
  if (f.marketOpen && o?.enabled) {
    const from = o.entryFrom ?? 555;
    const to = o.entryTo ?? 915;
    if (f.minutes < from) out.push(item('warn', `Options entries start at ${hhmm(from)}; it is ${f.clockText}.`));
    else if (f.minutes >= to) out.push(item('warn', `Options entries stopped at ${hhmm(to)}; it is ${f.clockText}.`));
  }
  out.push(...settingsItems(f));

  if (!f.niftyTick) out.push(item('bad', 'No Nifty price yet. The recorded seconds of this day have not started or are missing.'));
  if (f.niftyBars < MIN_NIFTY_BARS) out.push(item('bad', `Nifty has ${f.niftyBars} 1-minute candles; the options bot needs ${MIN_NIFTY_BARS}. No history before this day was saved, so it waits until about 10:15 on the replay clock. Press Download in Account > Studies > Data.`));
  else out.push(item('ok', `Nifty chart: ${f.niftyBars} candles.`));
  if (f.optionRead === 'none') out.push(item('warn', 'The options bot has not read the chart yet (it reads every 15 replay seconds while the market is open).'));
  else if (f.optionRead === 'notReady') out.push(item('bad', 'The options bot cannot read the Nifty chart yet: not enough candles or no daily history.'));

  const tried = f.pick?.symbol ? parseOptionSymbol(f.pick.symbol) : null;
  const listed = f.expiries.length ? `Expiries with a price now: ${f.expiries.map(mmm).join(', ')}.` : '';
  if (!f.expiries.length) out.push(item('bad', 'No option contract has a price at this moment of the replay.'));
  if (f.pick?.error || (f.pick && !f.pick.ltp)) out.push(item('bad', `No price for the strike the bot would buy${f.pick?.symbol ? ` (${f.pick.symbol}, expiry ${mmm(tried?.expiry)})` : ''}: "no live premium for the contract". ${listed}`));
  else if (f.pick) out.push(item('ok', `Strike the bot would buy now: ${f.pick.symbol} at ₹${f.pick.ltp} (expiry ${mmm(tried?.expiry)}, chosen on the replay date, skipping a contract that expires that day). ${listed}`));
  else if (f.expiries.length) out.push(item('bad', 'The bot found no strike to buy near the Nifty price.'));

  if (f.sharesWithBars < 20) out.push(item('warn', `Shares: only ${f.sharesWithBars} of 50 have the ${MIN_SHARE_BARS} candles the combinations need, so share combinations cannot run.`));
  if (f.sharesWithTick < 20) out.push(item('warn', `Shares: only ${f.sharesWithTick} of 50 have a price in this replay (they move once a minute from saved candles).`));

  const total = (seg) => f.log.filter((l) => l.segment === seg);
  for (const [seg, label] of [['OPT', 'Options'], ['EQ', 'Shares']]) {
    const rows = total(seg);
    const placed = rows.filter((l) => l.decision === 'PLACED').length;
    if (placed) out.push(item('ok', `${label}: ${placed} trade(s) bought in this replay.`));
    const reasons = new Map();
    for (const l of rows.filter((x) => x.decision === 'SKIPPED' && x.reason)) reasons.set(l.reason, (reasons.get(l.reason) ?? 0) + 1);
    for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 4)) out.push(item(placed ? 'ok' : 'warn', `${label} skipped ${n}×: ${reason}`));
  }
  if (!f.log.length) out.push(item('warn', 'The bots have not made any decision yet (no buy and no skip). Every skip is listed here as soon as one happens.'));
  for (const e of f.loadErrors.slice(0, 3)) out.push(item('bad', `Data could not be read: ${e}`));
  return out;
}

/** Reads what the running replay sees right now. */
export async function gatherWhyFacts({ market, optionTrader, scanner, engine, userId, istParts, config }) {
  const now = new Date();
  const parts = istParts(now);
  const status = engine.marketStatus();
  const [optionSettings, autoSettings, log, niftyBars, expiries] = await Promise.all([
    OptionSettings.findOne({ user: userId }).lean(),
    AutoSettings.findOne({ user: userId }).lean(),
    AutoLog.find({ user: userId, day: status.istDate }, 'segment decision reason').sort({ createdAt: -1 }).limit(400).lean(),
    market.getCandles(UNDERLYING, '1m').then((c) => c.length).catch(() => 0),
    market.provider.getOptionExpiries?.().catch(() => []) ?? [],
  ]);
  let pick = null;
  try {
    const p = await market.pickOption({ type: 'CE', now });
    pick = p ? { symbol: p.symbol, ltp: p.ltp } : null;
  } catch (e) {
    pick = { error: e.message };
  }
  const read = optionTrader?.lastReads?.get('NIFTY');
  const shares = NIFTY50.map((s) => s.symbol);
  return {
    dateText: mmm(parts.dateKey),
    clockText: `${String(Math.floor(parts.minutes / 60)).padStart(2, '0')}:${String(parts.minutes % 60).padStart(2, '0')}`,
    minutes: parts.minutes,
    marketOpen: Boolean(status.isOpen) || !config.enforceMarketHours,
    optionSettings,
    autoSettings,
    niftyTick: market.getTick(UNDERLYING),
    niftyBars,
    optionRead: !read ? 'none' : read.ready ? 'ready' : 'notReady',
    expiries,
    pick,
    sharesWithBars: shares.filter((s) => (scanner?.store?.get(s)?.length ?? 0) >= MIN_SHARE_BARS).length,
    sharesWithTick: shares.filter((s) => market.getTick(s)).length,
    log,
    loadErrors: market.provider.loadErrors ?? [],
  };
}
