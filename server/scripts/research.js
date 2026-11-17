// The night research: runs every study and every Learn mode on your saved data and writes one report, without changing any setting.
//   npm run research                       (the account whose option settings changed last)
//   npm run research -- --email you@x.com  (a given account)
//   npm run research -- --quick            (fewer searches, about 15 minutes)
// Run it after the market closes, with Upstox logged in today (the saved days are topped up from Upstox when needed).
// It writes research-report-<date>.md (to read and send back) and research-report-<date>.json (the full numbers) in the server folder.
// It never applies or saves settings: the Learn results show in Research > Learn as usual, and nothing is switched on.
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { createProvider } from '../src/market/providers/index.js';
import { MarketDataService } from '../src/market/MarketDataService.js';
import { HistorySync } from '../src/market/historySync.js';
import { StudyService } from '../src/study/service.js';
import { LabService } from '../src/lab/service.js';
import { LearnService } from '../src/learner/learnService.js';
import { User } from '../src/models/User.js';
import { OptionSettings } from '../src/models/OptionSettings.js';
import { researchReport } from './researchReport.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const quick = process.argv.includes('--quick');
const started = Date.now();
const mins = () => `${Math.round((Date.now() - started) / 60000)} min`;
const say = (t) => console.log(`[${mins()}] ${t}`);

await connectDb(env.mongoUri);
const market = new MarketDataService(createProvider(env), { holidays: env.nseHolidays, expiryWeekday: env.niftyExpiryWeekday, enforceHours: false });
new HistorySync({ market }); // the studies read the saved days first
try {
  await market.start();
} catch (e) {
  say(`Market feed did not start (${e.message}). Saved days are still used; log in to Upstox first if today is missing.`);
}
if (market.provider.isSimulated) say('WARNING: the mock feed is on (no Upstox). Saved days are used, but anything not saved is made up.');

const email = arg('email');
const user = email ? await User.findOne({ email: email.toLowerCase() }).lean() : await OptionSettings.findOne({}).sort({ updatedAt: -1 }).lean().then((s) => (s ? User.findById(s.user).lean() : null));
if (!user) {
  console.error(email ? `No account with the email ${email}.` : 'No account with option settings found.');
  process.exit(1);
}
const userId = String(user._id);
say(`Account: ${user.email}`);

const study = new StudyService({ market, config: env });
const lab = new LabService({ market, config: env });
const learn = new LearnService({ lab, market, study, config: env, searchMs: (quick ? 3 : 15) * 60 * 1000 }); // a longer search than in the app: nobody is waiting

const out = { generatedAt: new Date().toISOString(), account: user.email, quick, parts: {}, errors: {} };
const step = (name) => (s) => process.stdout.write(`\r[${mins()}] ${name}: ${String(s).slice(0, 90).padEnd(90)}`);
async function part(key, name, fn) {
  say(`${name}...`);
  try {
    out.parts[key] = await fn(step(name));
    process.stdout.write('\n');
    say(`${name}: done`);
  } catch (e) {
    process.stdout.write('\n');
    out.errors[key] = e.message;
    say(`${name}: FAILED (${e.message})`);
  }
}

const depth = quick ? 2 : 3;
await part('options', 'Options study (each indicator, your combinations, exits)', (s) => study.quietRun(userId, 'options', { days: 30, research: true, autoFind: true }, s));
await part('optionsFind', 'Options finder (new combinations, calls and puts)', (s) => study.quietRun(userId, 'options', { days: 30, pairFind: true, comboFind: true, winFind: true, pairDepth: depth, pairShow: 20, pairResearch: !quick }, s));
await part('optionsWinRate', 'Options finder (highest win rate)', (s) => study.quietRun(userId, 'options', { days: 30, pairFind: true, pairDepth: depth, pairShow: 20, pairGoal: 'winrate', pairResearch: false }, s));
await part('ladder', 'Ladder tester (profit ladders on your live entries)', (s) => study.quietRun(userId, 'ladder', { days: 30 }, s));
await part('moved', 'Already-moved tester', (s) => study.quietRun(userId, 'moved', { days: 30 }, s));
await part('shares', 'Shares study', (s) => study.quietRun(userId, 'shares', { days: 15 }, s));
await part('sharesFind', 'Shares finder (new combinations)', (s) => study.quietRun(userId, 'shares', { days: 15, pairFind: true, comboFind: true, pairDepth: depth, pairShow: 20 }, s));
for (const what of ['combos', 'setup', 'shares']) {
  const name = { combos: 'Learn: each combination', setup: 'Learn: whole setup', shares: 'Learn: shares' }[what];
  await part(`learn_${what}`, name, async (s) => {
    const job = learn.start(userId, { days: 30, what, by: 'you' });
    const watch = setInterval(() => s(learn.status(userId).step), 2000);
    try {
      await /** @type {any} */ (job).done;
    } finally {
      clearInterval(watch);
    }
    const v = await learn.view(userId);
    return what === 'combos' ? v.combos : what === 'shares' ? v.shares : v.last;
  });
}

// ---- the report ----
// the full numbers first, without the long trade lists, so a slip in the summary below never loses the night's work
const drop = (k, x) => ['recent', 'proposal', 'current'].includes(k) || (k === 'list' && Array.isArray(x?.[0])); // trade lists [time, net] are long
const prune = (v) => (Array.isArray(v) ? v.map(prune) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k, x]) => !drop(k, x)).map(([k, x]) => [k, prune(x)])) : v);
const day = out.generatedAt.slice(0, 10);
const mdFile = path.resolve(`research-report-${day}.md`);
const jsonFile = path.resolve(`research-report-${day}.json`);
fs.writeFileSync(jsonFile, JSON.stringify(prune(out)));
try {
  fs.writeFileSync(mdFile, researchReport(out, { email: user.email, took: mins() }));
} catch (e) {
  fs.writeFileSync(mdFile, `# Night research\n\nThe summary could not be written (${e.message}). Send the .json file: it has all the numbers.`);
}
say(`Done. Send these two files:\n  ${mdFile}\n  ${jsonFile}`);
try {
  await market.stop?.();
} catch {}
await disconnectDb();
process.exit(0);
