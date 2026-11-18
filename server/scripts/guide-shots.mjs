// Retakes the guide screenshots from the real client. Needs: node scripts/demo-server.js (port 5055) and the client dev server
// (cd client && VITE_DEV_API=http://localhost:5055 npx vite --port 5199). Writes PNGs to ./out; convert the ones listed in
// src/guide/figures.js to JPEG (585 px wide for phone, 1200 px for desktop) into src/guide/shots, then run scripts/build-guide.mjs --pdf.
// Usage: node scripts/guide-shots.mjs 390   (phone)   |   node scripts/guide-shots.mjs 1100   (desktop)
const { chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright');
const W = +(process.argv[2] || 390);
const tag = W < 600 ? 'm' : 'd';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: W, height: W < 600 ? 844 : 900 }, deviceScaleFactor: W < 600 ? 2 : 1.5 });
const p = await ctx.newPage();
await p.addInitScript(() => localStorage.setItem('npt_token', 'demo'));
const go = async (path) => { await p.goto('http://localhost:5199' + path, { waitUntil: 'networkidle' }); await p.waitForTimeout(1200); };
const shot = async (name, full = false) => { await p.waitForTimeout(500); await p.screenshot({ path: `out/${name}-${tag}.png`, fullPage: full }); console.log('shot', name); };
const click = async (text, opts = {}) => { try { await p.getByText(text, { exact: opts.exact ?? true }).first().click({ timeout: 4000 }); await p.waitForTimeout(700); return true; } catch { console.log('MISSING', text); return false; } };

await go('/'); await shot('stocks');
await go('/dashboard'); await p.locator('main').getByText('Options', { exact: true }).first().click(); await p.waitForTimeout(1000); await p.mouse.wheel(0, 700); await shot('pnl-top');
await p.mouse.wheel(0, 900); await shot('pnl-charts');
await go('/account'); await shot('more');
await go('/settings?seg=options'); await shot('settings');
await go('/combos?seg=options'); await shot('combos');
await go('/research?tab=test&tool=score'); await shot('study-form');
await p.mouse.wheel(0, 1700); await shot('study-results');
await p.getByText('Breakout + Engulfing, stop 1.5', { exact: false }).first().click(); await p.waitForTimeout(800);
const sc = p.getByText('If a minimum chart score was needed').first(); await sc.scrollIntoViewIfNeeded(); await shot('score-floors');
const v = p.getByRole('button', { name: /view/i }).first(); await v.scrollIntoViewIfNeeded(); await shot('study-trades'); await v.click(); await p.waitForTimeout(900); await shot('view-popup');
await go('/combos?seg=options'); if (await click('New combination', { exact: false })) { await shot('combo-new');
  try {
    await p.getByPlaceholder(/Name, for example/).fill('Morning trend (demo)');
    for (const q of ['Open drive', 'Squeeze', 'ADX rising']) {
      await p.getByPlaceholder(/Search the checks/).fill(q); await p.waitForTimeout(500);
      await p.getByText(new RegExp(q, 'i')).locator('visible=true').nth(0).click({ timeout: 3000 }).catch(() => console.log('MISSING pick', q));
      await p.waitForTimeout(400);
    }
  } catch (e) { console.log('combo fill failed', e.message.slice(0, 100)); } }
await b.close();
