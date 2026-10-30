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
  // a flying insect station: a pest starts as Caught, and more pests can be added (a glue board catches several)
  const ins = await sp.evaluate(`(() => {
    const ty = document.getElementById('newDeviceType'), s = document.getElementById('speciesCaught');
    ty.value = 'Flying Insect Monitoring'; updateFormTypeDot();
    const btnBefore = !document.getElementById('addPestBtn').classList.contains('hidden');
    s.value = 'House Fly'; updatePestCountField(true);
    const def = document.getElementById('activityLevel').value, btnShown = !document.getElementById('addPestBtn').classList.contains('hidden');
    document.getElementById('pestCount').value = '12';
    addMorePest();
    const row = document.querySelector('#morePests .more-pest');
    row.querySelector('.mp-species').value = 'Blowfly'; row.querySelector('.mp-count').value = '3';
    return { def, btnBefore, btnShown, more: readMorePests() };
  })()`);
  ok(ins.def === 'Caught' && !ins.btnBefore && ins.btnShown && ins.more.length === 1 && ins.more[0].species === 'Blowfly', 'insect station: Caught by default, and "Add another pest"', ins);
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
  ok(got && got.payload.speciesCaught === 'House Fly' && got.payload.pestCount === 12 && Array.isArray(got.payload.morePests) && got.payload.morePests[0].species === 'Blowfly' && got.payload.morePests[0].count === 3,
    'both pests saved on the one check', got && got.payload);
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
  const svcPdf = await sp.evaluate('({ saved: window.__pdf.saved.slice(), texts: window.__pdf.texts.slice() })');
  ok(svcPdf.saved.some(f => /^Acme Foods - Visit report - \d{4}-\d\d-\d\d\.pdf$/.test(f)) && svcPdf.texts.some(t => /Acme Foods · Visit report/.test(t)) && svcPdf.texts.includes('STATION RECORDS'.toLowerCase()) === false && svcPdf.texts.includes('Station records'),
    'Service App visit report is the shared (Client Portal) report', svcPdf.saved);
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
  const cliPdf = await cp.evaluate(`(async () => { const v = state.model.visits[0]; if (!v) return null; window.__pdf.links = []; await downloadVisitPdf(v.id); return { saved: window.__pdf.saved.slice(), texts: window.__pdf.texts.slice(), links: window.__pdf.links.slice() }; })()`);
  ok(cliPdf && cliPdf.links.some(u => /\/client\.html#\/site\/1\/overview\/station\/NEW-88$/.test(u)) && cliPdf.links.some(u => /#\/site\/1\/visits\/visit\//.test(u)),
    'visit report: stations and the visit link back to the Client Portal', cliPdf && cliPdf.links);
  // a link from a report opens that station
  await cp.goto(BASE + '/client.html#/site/1/overview/station/NEW-88'); await sleep(3000);
  ok(await cp.evaluate("!$('modal').classList.contains('hidden') && /Loading Dock/.test($('modal').textContent)"), 'a station link opens the station in the portal');
  await cp.evaluate('closeModal && closeModal(true)').catch(() => {});
  ok(cliPdf && cliPdf.saved.some(f => /^Acme Foods - Visit report - \d{4}-\d\d-\d\d\.pdf$/.test(f)) && cliPdf.texts.includes('Station records') && cliPdf.texts.some(t => /Pesties Client Portal/.test(t)),
    'Client Portal visit report: the same shared report', cliPdf && cliPdf.saved);
  // thumbnails are kept on the device: the first one is saved, the next one shows the saved copy straight away
  const th = await cp.evaluate(`(async () => {
    const [u] = await signPaths(['1/STATION_TEST_1.png']);
    if (!u) return 'no link';
    const box = Object.assign(document.createElement('div'), { className: 'thumb' }); box.innerHTML = '<img src="' + u + '">'; document.body.appendChild(box);
    for (let i = 0; i < 40 && !(await THUMBS.saved('station-photos/1/STATION_TEST_1.png')); i++) await new Promise(r => setTimeout(r, 100));
    const [u2] = await signPaths(['1/STATION_TEST_1.png']);
    const box2 = Object.assign(document.createElement('div'), { className: 'thumb' }); box2.innerHTML = '<img src="' + u2 + '">'; document.body.appendChild(box2);
    await new Promise(r => setTimeout(r, 300));
    const src = box2.querySelector('img').src; box.remove(); box2.remove();
    return src;
  })()`);
  ok(String(th).startsWith('blob:'), 'a thumbnail is saved on the device and shown from there the next time', th);
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

  // ---------- Critical limits report: insect by insect, insect stations only, no month to pick ----------
  const t2 = await session('tech@example.com', { name: 'Tina Tech' }), b2 = await session('boss@example.com');
  r = await api(t2)('clients', { op: 'insert', values: [{ Name: 'Limit Foods', Address: '2 Main St' }], returning: true });
  const sid = String(r.data[0].id);
  await api(b2)('site_limits', { op: 'insert', values: [{ id: 'limE', client_id: sid, name: 'Dispatch', rules: [{ species: 'House Fly', max: 10 }, { species: 'Blowfly', max: 5 }] }] });
  await api(t2)('stations', { op: 'insert', values: [{ id: 'stE1', client_id: sid, barcode: 'ILT-E1', name: 'Dock ILT', type: 'Flying Insect Monitoring', limit_id: 'limE' },
    { id: 'stE2', client_id: sid, barcode: 'RB-E1', name: 'Rodent box', type: 'Internal Non-Toxic Rodent Station', limit_id: 'limE' },
    { id: 'stE3', client_id: sid, barcode: 'ILT-E3', name: 'Quiet ILT', type: 'Flying Insect Monitoring', limit_id: 'limE' }] });
  const lg = (b, name, ty, n, more) => ({ client_id: Number(sid), barcode_id: b, payload: { locationName: name, deviceType: ty, activityLevel: 'Caught', speciesCaught: 'House Fly', pestCount: n, morePests: more || [], technician: 'Tina Tech', servicedAt: new Date(Date.now() - 3600000).toISOString() } });
  await api(t2)('service_logs', { op: 'insert', values: [lg('ILT-E1', 'Dock ILT', 'Flying Insect Monitoring', 4, [{ species: 'Blowfly', count: 7 }]), lg('RB-E1', 'Rodent box', 'Internal Non-Toxic Rodent Station', 30)] });
  await api(t2)('visits', { op: 'insert', values: [{ id: 'vE1', client_id: sid, technician: 'Tina Tech', visit_type: 'Routine Service', completed_at: new Date().toISOString() }] });
  await api(b2)('client_access', { op: 'insert', values: [{ email: 'cara@acme.test', client_id: sid }] });
  const lc = await newPage(browser, await session('cara@acme.test'));
  await lc.goto(`${BASE}/client.html#/site/${sid}/overview`); await sleep(3500);
  const limBell = await lc.evaluate("bellItems(true).filter(i => i.key.startsWith('lim:')).map(i => i.sub)");
  ok(limBell.length === 1 && /Blowfly/.test(limBell[0]), 'limit notification: only the insect over, and a rodent station never counts', limBell);
  await lc.evaluate("openLimitReport('ILT-E1')"); await sleep(1000);
  const lim = await lc.evaluate(() => ({ filters: Array.from(document.querySelectorAll('.pr-f')).map(f => f.textContent.replace(/\s+/g, ' ').trim()),
    alert: (document.querySelector('.pr-alert') || {}).innerText || '', pests: Array.from(document.querySelectorAll('.pr-lim-p > .pr-lim-ph b')).map(b => b.textContent) }));
  ok(!lim.filters.some(f => /^Month/.test(f)) && lim.filters.some(f => /Insect/.test(f)), 'critical limits: no month filter, an insect filter', lim.filters);
  ok(lim.filters.some(f => /Flying Insect Monitoring/.test(f)) && !lim.filters.some(f => /Rodent/.test(f)), 'critical limits: only insect station types', lim.filters);
  ok(/Blowfly - Dispatch: over in [A-Z][a-z]+ \d{4} \(7 of 5\)/.test(lim.alert) && !/House Fly/.test(lim.alert), 'critical limits: the alert names the insect that is over, and the month', lim.alert);
  ok(lim.pests[0] === 'Blowfly' && lim.pests.includes('House Fly'), 'critical limits: a section per insect, the one over first', lim.pests);
  ok(lim.filters.some(f => /^From/.test(f)) && lim.filters.some(f => /^To/.test(f)) && lim.filters.some(f => /^Breached.*Yes/.test(f)), 'critical limits: From and To months, and Breached (Yes to start with)', lim.filters);
  // Breached: Yes shows only the stations that breached; No shows every insect station on a limit
  const cardsNow = () => lc.evaluate(() => Array.from(document.querySelectorAll('.pr-lim > .pr-lim-h > b')).map(b => b.textContent.trim()));
  await lc.evaluate(() => { const b = Array.from(document.querySelectorAll('.pr-combo-btn')).find(x => /Dock ILT/.test(x.textContent)); if (b) b.click(); });
  await lc.evaluate(() => { const o = Array.from(document.querySelectorAll('.pr-combo-pop button, [role=option]')).find(x => /^All stations/.test(x.textContent.trim())); if (o) o.click(); }); await sleep(500);
  const breachedOnly = await cardsNow();
  await lc.evaluate(() => { const s = Array.from(document.querySelectorAll('.pr-f')).find(f => /^Breached/.test(f.textContent.trim())).querySelector('select'); s.value = 'no'; s.dispatchEvent(new Event('change')); }); await sleep(500);
  const every = await cardsNow();
  ok(breachedOnly.length === 1 && breachedOnly[0] === 'Dock ILT' && every.length === 2 && every.includes('Quiet ILT'), 'critical limits: Breached Yes hides stations that did not breach, No shows them', { breachedOnly, every });
  // Visits: the visit that breached has a red "!", says which limit, and the tab shows a red "!" while it's unopened
  await lc.evaluate("setTab('visits')"); await sleep(600);
  const vis = await lc.evaluate(() => ({ row: (document.querySelector('.visit-breach') || {}).innerText || '', mark: !!document.querySelector('.visit-breach .breach-mark'), tab: !!document.querySelector('.nav-tab .count.alert') }));
  ok(vis.mark && vis.tab && /Critical limit breach: Blowfly in Dispatch/.test(vis.row), 'visits: a breached visit has a red "!" and says which limit; the Visits tab shows "!"', vis);
  // no automatic sign-out; services due as a month; certain months each year
  ok(await lc.evaluate("typeof idleCheck === 'undefined' && !document.getElementById('idleWarning')"), 'portal: no automatic sign-out');
  ok(await lc.evaluate("freqLabel('months:2,3,11') === 'Feb, Mar, Nov each year' && dueText(toDayStr(new Date())).text === 'Due this month'"), 'portal: certain months, and "Due this month"');
  const svcDue = await sp.evaluate(() => {
    const first = new Date(); first.setDate(1);
    return { a: addFrequency('2026-03-15', 'months:2,3,11'), b: addFrequency('2026-11-30', 'months:2,3,11'), lbl: freqLabel('months:11,2,3'),
      now: dueInfo({ nextDue: toDayStr(first) }).text, idle: typeof idleCheck };
  });
  ok(svcDue.a === '2026-11-15' && svcDue.b === '2027-02-28' && svcDue.lbl === 'Feb, Mar, Nov each year' && svcDue.now === 'Due this month' && svcDue.idle === 'undefined', 'service app: certain months each year, "Due this month", no automatic sign-out', svcDue);
  const folders = await api(b2)('site_document_folders', { op: 'select', filters: [['client_id', 'eq', sid]] });
  ok((folders.data || []).some(f => f.name === 'Meeting notes') && !(folders.data || []).some(f => f.name === 'Meetings'), 'documents: the Meeting notes folder (not Meetings)', folders);
  ok(lc.errors.length === 0, 'critical limits: no errors', lc.errors);
} catch (e) { fails++; console.log('ERROR', e); }
finally {
  await browser.close();
  srv.stop();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
