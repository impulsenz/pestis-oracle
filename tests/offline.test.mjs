// Offline: the Service App's offline copy keeps the apps and pestis-db.js, never the server's data, and opens with no connection.
// Needs PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1 (run.sh sets it).
import path from 'node:path';
import { start, idToken, playwright, STUBS_DIR, tmpDir } from './harness.mjs';
const { chromium } = playwright();
const PORT = 8096, BASE = `http://127.0.0.1:${PORT}`;
const srv = await start({ port: PORT, dataDir: tmpDir('offline') });
let fails = 0, passes = 0;
const ok = (c, m, x) => { if (c) { passes++; console.log('PASS', m); } else { fails++; console.log('FAIL', m, x !== undefined ? JSON.stringify(x).slice(0, 500) : ''); } };
const browser = await chromium.launch();
try {
  const sess = (await (await fetch(BASE + '/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: idToken('boss@example.com') }) })).json()).session;
  const ctx = await browser.newContext();
  await ctx.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) { localStorage.setItem(k, v); localStorage.setItem('pestis-last-active', String(Date.now())); } }, ['sb-127-auth-token', JSON.stringify(sess)]);
  const STUBS = { 'cdn.tailwindcss.com': 'tailwind-real.js', 'html5-qrcode': 'qr-stub.js', 'jspdf': 'jspdf-stub.js' };
  await ctx.route('**/*', async r => { const u = r.request().url(); for (const [k, f] of Object.entries(STUBS)) if (u.includes(k)) return r.fulfill({ path: path.join(STUBS_DIR, f), contentType: 'application/javascript' }); if (u.startsWith(BASE)) return r.continue(); return r.fulfill({ status: 404, body: '' }); });
  const page = await ctx.newPage();
  await page.goto(BASE + '/index.html'); await page.waitForTimeout(2000);
  await page.evaluate(async () => { await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready; });   // the app only does this on https
  await page.reload(); await page.waitForTimeout(4000);
  ok(await page.evaluate('!!navigator.serviceWorker.controller'), 'offline copy is running');
  const saved = await page.evaluate(async () => { const out = []; for (const k of await caches.keys()) out.push(...(await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname)); return out; });
  ok(!saved.some(p => /^\/(api|rest|auth)\//.test(p)), 'no server calls kept', saved);
  ok(saved.includes('/pestis-db.js'), 'pestis-db.js kept for offline', saved);
  await ctx.setOffline(true);
  await page.reload(); await page.waitForTimeout(5000);
  ok(await page.isVisible('#appRoot'), 'Service App opens offline');
} catch (e) { fails++; console.log('ERROR', e); }
finally {
  await browser.close(); srv.stop();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
