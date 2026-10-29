// End-to-end: the three real apps in Chromium against the real Pestis server.
import path from 'node:path';
import fs from 'node:fs';
import { start, idToken, mails, playwright, STUBS_DIR, tmpDir } from './harness.mjs';
const { chromium } = playwright();

const PORT = 8095, BASE = `http://127.0.0.1:${PORT}`;
const B = STUBS_DIR;
const SHOTS = tmpDir('shots'); fs.mkdirSync(SHOTS, { recursive: true });
const srv = await start({ port: PORT, dataDir: tmpDir('e2e') });
const KEY = 'sb-127-auth-token';
let fails = 0, passes = 0;
const ok = (c, m, x) => { if (c) { passes++; console.log('PASS', m); } else { fails++; console.log('FAIL', m, x !== undefined ? JSON.stringify(x).slice(0, 500) : ''); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function session(email, extra) {
  const r = await fetch(BASE + '/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: idToken(email, extra) }) });
  return (await r.json()).session;
}
const api = (s) => async (table, body) => {
  const r = await fetch(BASE + '/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.access_token }, body: JSON.stringify(Object.assign({ table }, body)) });
  return r.json();
};
const rpc = (s) => async (name, args) => (await fetch(BASE + '/api/rpc/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.access_token }, body: JSON.stringify(args || {}) })).json();

const STUBS = { 'cdn.tailwindcss.com': 'tailwind-real.js', 'html5-qrcode': 'qr-stub.js', 'jspdf': 'jspdf-stub.js', 'jszip': 'jszip.min.js' };
async function newPage(browser, sess, w = 1280) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
  if (sess) await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem(k, v); localStorage.setItem('pestis-last-active', String(Date.now())); sessionStorage.setItem('__seeded', '1'); } }, [KEY, JSON.stringify(sess)]);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/.test(m.text())) page.errors.push('CONSOLE ' + m.text()); });
  page.on('dialog', d => d.accept());
  await page.route('**/*', async r => {
    const url = r.request().url();
    for (const [k, f] of Object.entries(STUBS)) if (url.includes(k)) return r.fulfill({ path: path.join(B, f), contentType: 'application/javascript' });
    if (url.startsWith(BASE)) return r.continue();
    if (url.startsWith('https://accounts.google.com/')) { page.googleUrl = url; return r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Google</h1>' }); }
    return r.fulfill({ status: 404, body: '' });
  });
  return page;
}

const browser = await chromium.launch();
try {
  // ---------- people and a site, made through the server ----------
  const boss = await session('boss@example.com');
  await api(boss)('allowed_emails', { op: 'upsert', values: { email: 'tech@example.com', role: 'technician' } });
  const tech = await session('tech@example.com', { name: 'Tina Tech' });
  let r = await api(tech)('clients', { op: 'insert', values: [{ Name: 'Acme Foods', Address: '1 Main St', Contact: 'Jane Smith 021 123 4567', Email: 'jane@acme.test', Notes: 'Gate 1234' }], returning: true });
  ok(r.data && r.data[0].id === 1, 'site made', r);
  await api(tech)('stations', { op: 'insert', values: [{ id: 'st1', client_id: '1', barcode: 'TOX-1', name: 'Store Room', type: 'Internal Toxic Rodent Station' }] });
  await api(tech)('service_logs', { op: 'insert', values: [{ client_id: 1, barcode_id: 'TOX-1', payload: { locationName: 'Store Room', deviceType: 'Internal Toxic Rodent Station', activityLevel: 'None', technician: 'Tina Tech', servicedAt: new Date().toISOString(), clientRef: 'seed1' } }] });
  await api(tech)('recommendations', { op: 'insert', values: [{ id: 'rec-1', client_id: '1', station_barcode: 'TOX-1', station_name: 'Store Room', text: 'Seal the gap by the door', raised_by: 'Tina Tech' }] });
  await api(boss)('client_users', { op: 'insert', values: { email: 'cara@acme.test', full_name: 'Cara Client', company: 'Acme' } });
  await api(boss)('client_access', { op: 'insert', values: [{ email: 'cara@acme.test', client_id: '1' }] });

  // ---------- Service App ----------
  const sp = await newPage(browser, tech);
  await sp.goto(BASE + '/index.html');
  await sp.waitForSelector('.site-card', { timeout: 20000 }).catch(() => {});
  ok(await sp.isVisible('#appRoot') && !(await sp.isVisible('#loginScreen')), 'Service App opens signed in');
  ok(await sp.isVisible(".site-card[data-id='1']"), 'site card shows');
  await sp.click(".site-card[data-id='1']");
  await sp.waitForSelector('#siteLandingDashboard:not(.hidden)', { timeout: 20000 });
  await sleep(2500);
  const liveState = await sp.evaluate('typeof liveState !== "undefined" ? liveState : null');
  ok(liveState === 'live', 'live updates connected', liveState);
  ok(await sp.evaluate("siteDevices.some(d => d.barcode === 'TOX-1' || d.barcodeId === 'TOX-1' || d.id === 'TOX-1')") || (await sp.textContent('body')).includes('Store Room'), 'site data downloaded');
  // a station check, start to finish
  await sp.evaluate("chooseVisitType = async () => 'Routine Service'");
  await sp.click('#startServiceLabel'); await sleep(800);
  await sp.evaluate("handleScannedBarcode('NEW-88')"); await sleep(800);
  // Pest found: the guide's categories, with Rat and Mouse under Rodents and a Moths group
  const groups = await sp.evaluate("Array.from(document.querySelectorAll('#speciesCaught optgroup')).map(g => g.label)");
  ok(groups.some(g => g === 'Rodents') && groups.some(g => g.startsWith('Moths')) && groups.some(g => g.startsWith('Stored product pests')), 'Pest found is grouped like the pest guide', groups);
  ok(await sp.evaluate("JSON.stringify(pestCategories(speciesItems())) === JSON.stringify(Array.from(new Set(Array.from(document.querySelectorAll('#speciesCaught optgroup')).map(g => g.label.split(' · ')[0]))))"), 'Pest found categories are the pest guide categories, in the same order');
  // rodents: a non-toxic station records Caught (with the number); a toxic station records None / Low / Medium / High
  const rodent = await sp.evaluate(`(() => {
    const s = document.getElementById('speciesCaught'), a = document.getElementById('activityLevel'), row = document.getElementById('pestCountRow'), ty = document.getElementById('newDeviceType');
    const before = ty.value;
    ty.value = 'External Non-Toxic Rodent Station'; updateFormTypeDot();
    s.value = 'Rat'; updatePestCountField(true);
    const trap = { levels: Array.from(a.options).map(o => o.value).join(), countShown: !row.classList.contains('hidden') };
    ty.value = 'Internal Toxic Rodent Station'; updateFormTypeDot();
    const toxic = { levels: Array.from(a.options).map(o => o.value).join(), countHidden: row.classList.contains('hidden') };
    a.value = 'High'; updatePestCountField(); toxic.highHidden = row.classList.contains('hidden');
    s.selectedIndex = 0; ty.value = before; updateFormTypeDot(); updatePestCountField(true);
    return { trap, toxic, types: Array.from(ty.options).map(o => o.value) };
  })()`);
  ok(rodent.trap.levels === 'Caught' && rodent.trap.countShown, 'non-toxic rodent station: Caught only, with the number', rodent.trap);
  ok(rodent.toxic.levels === 'None,Low,Medium,High' && rodent.toxic.countHidden && rodent.toxic.highHidden, 'toxic rodent station: None / Low / Medium / High only', rodent.toxic);
  ok(rodent.types.includes('Crawling Insect Monitoring') && !rodent.types.some(t => /snap trap|^internal rodent station$/i.test(t)), 'station types renamed, no Snap Trap', rodent.types);
  ok(await sp.evaluate("!!document.getElementById('changeBarcodeBtn').closest('#newStationFields') && !!document.getElementById('scannedBarcodeBadge').parentElement.querySelector('#changeBarcodeBtn')"), 'Change barcode sits beside the barcode in the station details');
  await sp.fill('#newLocName', 'Loading Dock');
  if (await sp.isEnabled('#batchNumber').catch(() => false)) await sp.fill('#batchNumber', 'B-1');
  const saved = await sp.evaluate('saveStationServiceRecord()'); await sleep(500);
  ok(saved !== false, 'station record saved in the app');
  await sp.evaluate('flushQueue && flushQueue()');
  let got = null;
  for (let i = 0; i < 40; i++) {
    const s = await api(tech)('service_logs', { filters: [['barcode_id', 'eq', 'NEW-88']] });
    if (s.data && s.data.length) { got = s.data[0]; break; }
    await sleep(250);
  }
  ok(got && got.payload && got.payload.locationName === 'Loading Dock' && got.technician_id, 'record reached the server', got);
  const unsent = await sp.evaluate("queueItems.filter(i => i.status !== 'sent').map(i => i.kind + ':' + (i.error || i.lastError || ''))");
  ok(unsent.length === 0 || unsent.every(u => !/error|fail|denied/i.test(u)), 'upload queue clear', unsent);
  // something changed elsewhere arrives live
  await api(boss)('recommendations', { op: 'insert', values: [{ id: 'rec-live', client_id: '1', text: 'Live from admin', station_barcode: 'TOX-1' }] });
  let seen = false;
  for (let i = 0; i < 20 && !seen; i++) { await sleep(250); seen = await sp.evaluate("(async () => { let f = false; await withSiteCache('1', c => { f = !!(c && (c.recs || []).some(r => r.id === 'rec-live')); return false; }); return f; })()"); }
  ok(seen, 'live update reached the Service App');
  // Sync Data: the data uploaded on this visit
  await sp.evaluate('openQueueModal()'); await sleep(300);
  const vd = await sp.evaluate("({ bytes: visitData && visitData.bytes, site: visitData && visitData.site, text: document.getElementById('visitDataLine').textContent })");
  ok(vd.bytes > 0 && vd.site === '1' && /Data uploaded this visit: [\d.]+ (B|KB|MB)/.test(vd.text), 'Sync Data shows the data uploaded on this visit', vd);
  await sp.screenshot({ path: SHOTS + '/sync.png' });
  await sp.evaluate('closeQueueModal()');
  // floor plans: no size to choose; the page is sized to fit what's drawn when it's saved
  const fit = await sp.evaluate(`(async () => {
    const noSize = !document.getElementById('mapEditSize');
    await peOpen({ name: 'Fit test' });
    const d = pe.doc, p = d.ppm, cx = d.w / 2, cy = d.h / 2, before = [d.w / p, d.h / p];
    const view0 = pe.view.z;
    [[0, 0], [10, 0], [10, 5], [0, 5]].forEach(([x, y], i) => d.nodes.push({ id: 'fn' + i, x: cx + x * p, y: cy + y * p }));
    d.rooms.push({ id: 'fr', nodes: ['fn0', 'fn1', 'fn2', 'fn3'] });
    peFitPage(d);
    const after = [Math.round(d.w / p * 10) / 10, Math.round(d.h / p * 10) / 10], corner = [d.nodes[0].x / p, d.nodes[0].y / p];
    peClose(true);
    return { noSize, before, after, corner, view0 };
  })()`);
  ok(fit.noSize && fit.before[0] === 200 && fit.after[0] === 16.6 && fit.after[1] === 11.6 && Math.abs(fit.corner[0] - 3.3) < 0.1, 'floor plan page fits the drawing plus a margin', fit);
  await sp.screenshot({ path: SHOTS + '/service.png' });
  // finish the visit
  await sp.click("#visitWorkspace >> text=Complete & Close Visit"); await sleep(400);
  if (await sp.isVisible('#choiceModal')) { await sp.click('#choiceB'); await sleep(300); }
  await sp.evaluate("document.getElementById('closingSiteNotes').value ||= 'All good'; signOff = { reason: 'Not on site' }");
  await sp.click("#completeVisitModal button:has-text('Submit & Download')"); await sleep(1500);
  await sp.evaluate('flushQueue && flushQueue()');
  let visit = null;
  for (let i = 0; i < 40 && !visit; i++) { const v = await api(tech)('visits', {}); visit = v.data && v.data[0]; if (!visit) await sleep(250); }
  ok(visit && visit.client_id === '1' && visit.technician_id, 'completed visit reached the server', visit);
  // a photo uploaded by the app's queue
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await sp.evaluate(async b64 => {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const r = await _supabase.storage.from(PHOTO_BUCKET).upload('1/STATION_TEST_1.png', new Blob([bin], { type: 'image/png' }), { contentType: 'image/png', upsert: false });
    if (r.error) return 'ERR ' + r.error.message;
    const s = await _supabase.storage.from(PHOTO_BUCKET).createSignedUrl('1/STATION_TEST_1.png', 60);
    const img = new Image(); img.src = s.data.signedUrl; await img.decode(); return img.naturalWidth;
  }, png.toString('base64'));
  ok(up === 1, 'photo uploads and shows from its link', up);
  ok(sp.errors.length === 0, 'Service App: no errors', sp.errors);

  // ---------- Admin ----------
  const ad = await newPage(browser, boss);
  await ad.goto(BASE + '/admin.html'); await sleep(4000);
  const adminText = await ad.textContent('body');
  ok(!(await ad.isVisible('#loginScreen')) && /Acme Foods/.test(adminText), 'Admin opens signed in with the site', adminText.slice(0, 200));
  const profs = await api(boss)('profiles', {});
  ok(profs.data.length === 2, 'two staff profiles', profs.data.map(p => p.email));
  await ad.screenshot({ path: SHOTS + '/admin.png' });
  ok(ad.errors.length === 0, 'Admin: no errors', ad.errors);

  // ---------- Client Portal (emailed link) ----------
  const cp = await newPage(browser, null, 390);
  await cp.goto(BASE + '/client.html'); await sleep(1500);
  const emailBox = await cp.$('input[type=email]');
  ok(!!emailBox, 'portal shows sign-in');
  await emailBox.fill('cara@acme.test');
  const before = mails.length;
  await cp.click('button:has-text("link")'); await sleep(1200);
  ok(mails.length === before + 1, 'sign-in email sent', mails.length);
  const mail = mails[mails.length - 1] || '';
  const b64 = (mail.split('Content-Type: text/plain; charset=UTF-8')[1] || '').split('--pestis')[0].replace('Content-Transfer-Encoding: base64', '').replace(/\s+/g, '');
  const link = (/(http:\/\/\S+\/auth\/callback\?link=\S+)/.exec(Buffer.from(b64, 'base64').toString()) || [])[1];
  await cp.goto(link); await sleep(3500);
  ok(cp.url().includes('/client.html'), 'link lands on the portal', cp.url());
  const ptext = await cp.textContent('body');
  ok(/Acme Foods/.test(ptext), 'client sees their site', ptext.slice(0, 300));
  ok(!/Gate 1234/.test(ptext), 'staff notes hidden');
  await cp.goto(BASE + '/client.html#/site/1/overview'); await sleep(3000);
  const otext = await cp.textContent('body');
  ok(/Seal the gap/.test(otext), 'client sees the recommendation', otext.slice(0, 400));
  await cp.screenshot({ path: SHOTS + '/portal.png' });
  ok(cp.errors.length === 0, 'Portal: no errors', cp.errors);

  // ---------- Google sign-in from the login screen ----------
  const lp = await newPage(browser, null);
  await lp.goto(BASE + '/index.html'); await sleep(1500);
  ok(await lp.isVisible('#loginScreen'), 'Service App shows sign-in when signed out');
  await lp.evaluate('signInWithGoogle()'); await sleep(1500);
  const g = lp.googleUrl ? new URL(lp.googleUrl) : null;
  ok(g && g.searchParams.get('response_type') === 'id_token' && g.searchParams.get('redirect_uri') === BASE + '/auth/callback' && g.searchParams.get('client_id'), 'goes to Google with the right settings', lp.googleUrl);
  await lp.goto(BASE + '/api/health');   // back on the Pestis address (same tab) to read what the sign-in remembered
  const started = await lp.evaluate("JSON.parse(sessionStorage.getItem('pestis-google-signin'))");
  const tok = idToken('tech@example.com', { nonce: started.nonce, name: 'Tina Tech' });
  await lp.goto(`${BASE}/auth/callback#id_token=${tok}&state=${started.state}`);
  await lp.waitForURL(u => String(u).endsWith('/index.html'), { timeout: 10000 }).catch(() => {});
  await sleep(3000);
  ok(lp.url().endsWith('/index.html') && await lp.isVisible('#appRoot') && !(await lp.isVisible('#loginScreen')), 'back in the Service App, signed in', lp.url());
  // wrong state is refused
  await lp.goto(`${BASE}/auth/callback#id_token=${tok}&state=wrong`); await sleep(800);
  ok(/didn't work/.test(await lp.textContent('body')), 'mismatched sign-in refused');
  ok(lp.errors.length === 0, 'login flow: no errors', lp.errors);
} catch (e) { fails++; console.log('ERROR', e); }
finally {
  await browser.close();
  srv.stop();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
