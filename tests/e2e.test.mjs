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
  // overview boxes on a computer: the photo cards share the box width (3 across in a usual box), no empty space at the side
  const grids = await sp.evaluate(() => Array.from(document.querySelectorAll('.land-card .nf-grid')).filter(g => g.offsetParent).map(g => { const c = g.closest('.land-card'), cs = getComputedStyle(c);
    return { id: g.id, box: c.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), cols: getComputedStyle(g).gridTemplateColumns.split(' ').length, spare: g.clientWidth - Array.from(g.children).filter(x => x.classList.contains('nf-card')).reduce((m, x) => Math.max(m, x.offsetLeft + x.offsetWidth - g.offsetLeft), 0) }; }));
  ok(grids.length > 0 && grids.every(g => g.box >= 820 ? g.cols >= 3 : g.box >= 400 ? g.cols === 3 : g.cols === 2), 'overview: photo cards fit 3 across in a usual box', grids);
  await sp.screenshot({ path: SHOTS + '/overview-cards.png', fullPage: true });
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
    s.value = 'Fly'; updatePestCountField(true);
    const def = document.getElementById('activityLevel').value, btnShown = !document.getElementById('addPestBtn').classList.contains('hidden');
    document.getElementById('pestCount').value = '12';
    addMorePest();
    const row = document.querySelector('#morePests .more-pest');
    row.querySelector('.mp-species').value = 'Blowfly'; row.querySelector('.mp-count').value = '3';
    return { def, btnBefore, btnShown, more: readMorePests() };
  })()`);
  ok(ins.def === 'Caught' && !ins.btnBefore && ins.btnShown && ins.more.length === 1 && ins.more[0].species === 'Blowfly', 'insect station: Caught by default, and "Add another pest"', ins);
  await sp.fill('#newLocName', 'Loading Dock');
  // a flying insect station gets a glue board (Glue Board is on the preparations list)
  ok(await sp.evaluate("gluePrep() === 'Glue Board'"), 'Glue Board is the glue board preparation', await sp.evaluate('gluePrep()'));
  await sp.evaluate('applyGlueBoard()');
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
  ok(got && got.payload.speciesCaught === 'Fly' && got.payload.pestCount === 12 && Array.isArray(got.payload.morePests) && got.payload.morePests[0].species === 'Blowfly' && got.payload.morePests[0].count === 3,
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
  // Sites: a card for each site; tap one for its page, change its details, and (another site) delete it
  await api(boss)('clients', { op: 'insert', values: [{ Name: 'Throwaway Site', Address: '2 Bin Rd' }] });
  await ad.evaluate('loadClients ? loadClients() : null').catch(() => {}); await sleep(800);
  await ad.evaluate("setAdminTab('sites')"); await sleep(800);
  const cards = await ad.evaluate(() => Array.from(document.querySelectorAll('#adminSites .site-card .site-name')).map(x => x.textContent));
  ok(cards.includes('Acme Foods'), 'Admin › Sites: a card for each site', cards);
  await ad.evaluate("openAdminSite('1')"); await sleep(1500);
  const page = await ad.evaluate(() => ({ title: (document.querySelector('#adminSites h3') || {}).textContent, stations: (document.getElementById('asStations') || {}).innerText || '', sections: Array.from(document.querySelectorAll('#adminSites .eyebrow')).map(x => x.textContent) }));
  ok(page.title === 'Acme Foods' && /Store Room/.test(page.stations) && ['Site details', 'Services & schedule', 'Site contacts', 'Visits', 'Stations', 'Documents', 'Client portal logins', 'Critical limits', 'Delete this site'].every(s => page.sections.includes(s)), 'Admin › Sites: a site page with every section', page);
  await ad.fill('#asd_Address', '1 Main St, Gisborne');
  await ad.evaluate("saveAdminSiteDetails('1')"); await sleep(400);
  await ad.evaluate('flushQueue && flushQueue()'); await sleep(1500);
  const site1 = ((await api(boss)('clients', { filters: [['id', 'eq', 1]] })).data || [])[0];
  ok(site1 && site1.Address === '1 Main St, Gisborne', 'Admin › Sites: the site page saves the site details', site1 && site1.Address);
  const throwId = String(((await api(boss)('clients', {})).data || []).find(c => c.Name === 'Throwaway Site').id);
  await ad.evaluate('loadClients ? loadClients() : null').catch(() => {}); await sleep(800);
  ad.removeAllListeners('dialog');
  ad.on('dialog', d => d.type() === 'prompt' ? d.accept('Throwaway Site') : d.accept());
  await ad.evaluate(id => { openAdminSite(id); return deleteAdminSite(id); }, throwId); await sleep(800);
  ad.removeAllListeners('dialog'); ad.on('dialog', d => d.accept());
  const left = ((await api(boss)('clients', {})).data || []).map(c => c.Name);
  ok(!left.includes('Throwaway Site') && left.includes('Acme Foods'), 'Admin › Sites: delete a site (typing its name to confirm)', left);
  // Users: sign someone out of all their devices
  const temp = await session('temp@example.com', { name: 'Temp Person' });
  await session('temp@example.com', { name: 'Temp Person' });
  await ad.evaluate("setAdminTab('team')"); await sleep(1500);
  const soBtn = await ad.evaluate(() => { const b = document.querySelector('[data-email="temp@example.com"][onclick^="signOutEverywhere"]'); return b ? { text: b.textContent, disabled: b.disabled } : null; });
  ok(soBtn && !soBtn.disabled && /all 2 devices/.test(soBtn.text), 'Admin › Users: "Sign out of all 2 devices" for someone signed in twice', soBtn);
  await ad.evaluate(() => signOutEverywhere('temp@example.com')); await sleep(800);
  const tempOk = (await fetch(BASE + '/api/auth/user', { headers: { Authorization: 'Bearer ' + temp.access_token } })).ok;
  const soAfter = await ad.evaluate(() => { const b = document.querySelector('[data-email="temp@example.com"][onclick^="signOutEverywhere"]'); return b ? { text: b.textContent, disabled: b.disabled } : null; });
  ok(!tempOk && soAfter && soAfter.disabled && /Not signed in/.test(soAfter.text), 'Admin › Users: they are signed out everywhere', { tempOk, soAfter });
  await ad.evaluate("setAdminTab('overview')"); await sleep(300);
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
  await api(t2)('service_logs', { op: 'insert', values: [lg('ILT-E1', 'Dock ILT', 'Flying Insect Monitoring', 4, [{ species: 'Blowfly', count: 7 }]), lg('RB-E1', 'Rodent box', 'Internal Non-Toxic Rodent Station', 30),
    // 8 house flies here and 4 at the Dock: 12 together, but each station is under its own limit of 10 - no breach
    lg('ILT-E3', 'Quiet ILT', 'Flying Insect Monitoring', 8)] });
  await api(t2)('visits', { op: 'insert', values: [{ id: 'vE1', client_id: sid, technician: 'Tina Tech', visit_type: 'Routine Service', completed_at: new Date().toISOString() }] });
  await api(b2)('client_access', { op: 'insert', values: [{ email: 'cara@acme.test', client_id: sid }] });
  const lc = await newPage(browser, await session('cara@acme.test'));
  await lc.goto(`${BASE}/client.html#/site/${sid}/overview`); await sleep(3500);
  const limBell = await lc.evaluate("bellItems(true).filter(i => i.key.startsWith('lim:')).map(i => i.sub)");
  ok(limBell.length === 1 && /Blowfly: 7 this month/.test(limBell[0]), 'limit notification: per station - only Blowfly at the Dock is over; stations under their own limit and a rodent station never count', limBell);
  // tapping the notification opens the report, and the notification goes away
  await lc.evaluate(() => { toggleBell(); const b = Array.from(document.querySelectorAll('#bellPanel button[data-key^="lim:"]'))[0]; b.click(); }); await sleep(1000);
  ok((await lc.evaluate("bellItems().filter(i => i.key.startsWith('lim:')).length")) === 0 && (await lc.evaluate("state.tab")) === 'reports', 'limit notification: tapping it opens the critical limits report and clears it');
  await lc.evaluate("openLimitReport('ILT-E1')"); await sleep(1000);
  const lim = await lc.evaluate(() => ({ filters: Array.from(document.querySelectorAll('.pr-f')).map(f => f.textContent.replace(/\s+/g, ' ').trim()),
    alert: (document.querySelector('.pr-alert') || {}).innerText || '', pests: Array.from(document.querySelectorAll('.pr-lim-p > .pr-lim-ph b')).map(b => b.textContent) }));
  ok(!lim.filters.some(f => /^Month/.test(f)) && lim.filters.some(f => /Insect/.test(f)), 'critical limits: no month filter, an insect filter', lim.filters);
  ok(lim.filters.some(f => /Flying Insect Monitoring/.test(f)) && !lim.filters.some(f => /Rodent/.test(f)), 'critical limits: only insect station types', lim.filters);
  ok(/Blowfly · 1 station over/.test(lim.alert) && /Dock ILT\s+Blowfly\s+[A-Z][a-z]+ \d{4}\s+7 of 5 \+2/.test(lim.alert) && !/House Fly/.test(lim.alert), 'critical limits: the alert names the insect, the station over its own limit, and the month', lim.alert);
  ok(lim.pests[0] === 'Blowfly' && lim.pests.includes('House Fly'), 'critical limits: a section per insect, the one over first', lim.pests);
  ok(lim.filters.some(f => /^From/.test(f)) && lim.filters.some(f => /^To/.test(f)) && lim.filters.some(f => /^Breached.*Yes/.test(f)), 'critical limits: From and To months, and Breached (Yes to start with)', lim.filters);
  // Breached: Yes shows only the stations that breached; No shows every insect station on a limit
  const cardsNow = () => lc.evaluate(() => Array.from(document.querySelectorAll('.pr-lim > .pr-lim-h > b')).map(b => b.textContent.trim()));
  await lc.evaluate(() => { const b = Array.from(document.querySelectorAll('.pr-combo-btn')).find(x => /Dock ILT/.test(x.textContent)); if (b) b.click(); });
  // the station list is tick boxes: Clear, then Done (nothing ticked = every station)
  await lc.evaluate(() => { document.querySelector('.pr-combo-pop [data-act=none]').click(); document.querySelector('.pr-combo-pop [data-act=done]').click(); }); await sleep(500);
  const breachedOnly = await cardsNow();
  await lc.evaluate(() => { const s = Array.from(document.querySelectorAll('.pr-f')).find(f => /^Breached/.test(f.textContent.trim())).querySelector('select'); s.value = 'no'; s.dispatchEvent(new Event('change')); }); await sleep(500);
  const every = await cardsNow();
  ok(breachedOnly.length === 1 && breachedOnly[0] === 'Dock ILT' && every.length === 2 && every.includes('Quiet ILT'), 'critical limits: Breached Yes hides stations that did not breach, No shows them', { breachedOnly, every });
  // the Reports tab, tapped while in a report, goes back to the list of reports (and so does coming back from another tab)
  const repTab = () => lc.evaluate(() => { const b = Array.from(document.querySelectorAll('#siteTabs .nav-tab')).find(x => /^Reports/.test(x.textContent.trim())); b.click(); });
  const onList = () => lc.evaluate(() => !!document.querySelector('.pr-pick') && !document.querySelector('.pr-back'));
  await lc.evaluate("setTab('reports')"); await sleep(600);
  ok(!(await onList()), 'reports: inside a report to start with');
  await repTab(); await sleep(600);
  ok(await onList(), 'reports: tapping Reports while in a report goes back to the list of reports');
  await lc.evaluate(() => document.querySelector('.pr-card').click()); await sleep(500);
  await lc.evaluate("setTab('overview')"); await sleep(600);
  await repTab(); await sleep(800);
  ok(await onList(), 'reports: tapping Reports from another tab opens the list of reports');
  await lc.evaluate("PR.show(state.prBox, 'station')"); await sleep(600);
  const showOpts = await lc.evaluate(() => { const f = Array.from(document.querySelectorAll('.pr-f')).find(x => /^Show/.test(x.textContent.trim())); return f ? Array.from(f.querySelectorAll('option')).map(o => o.textContent) : []; });
  ok(showOpts[0] === 'Month by month' && !showOpts.includes('Over time'), 'One station: "Show" offers Month by month (not Over time)', showOpts);
  // Visits: the visit that breached has a red "!", says which limit, and the tab shows a red "!" while it's unopened
  await lc.evaluate("setTab('visits')"); await sleep(600);
  const vis = await lc.evaluate(() => ({ row: (document.querySelector('.visit-breach') || {}).innerText || '', mark: !!document.querySelector('.visit-breach .breach-mark'), tab: !!document.querySelector('.nav-tab .count.alert') }));
  ok(vis.mark && vis.tab && /Critical limit breach: Dock ILT - Blowfly 7 caught this month, its limit 5/.test(vis.row), 'visits: a breached visit has a red "!" and says which limit; the Visits tab shows "!"', vis);
  // no automatic sign-out; services due as a month; certain months each year
  ok(await lc.evaluate("typeof idleCheck === 'undefined' && !document.getElementById('idleWarning')"), 'portal: no automatic sign-out');
  ok(await lc.evaluate("freqLabel('months:2,3,11') === 'Feb, Mar, Nov each year' && dueText(toDayStr(new Date())).text === 'Due this month'"), 'portal: certain months, and "Due this month"');
  const svcDue = await sp.evaluate(() => {
    const first = new Date(); first.setDate(1);
    return { a: addFrequency('2026-03-15', 'months:2,3,11'), b: addFrequency('2026-11-30', 'months:2,3,11'), lbl: freqLabel('months:11,2,3'),
      now: dueInfo({ nextDue: toDayStr(first) }).text, idle: typeof idleCheck };
  });
  ok(svcDue.a === '2026-11-15' && svcDue.b === '2027-02-28' && svcDue.lbl === 'Feb, Mar, Nov each year' && svcDue.now === 'Due this month' && svcDue.idle === 'undefined', 'service app: certain months each year, "Due this month", no automatic sign-out', svcDue);
  // Service App: a limit applies to each station on its own (Midges 150): 120 + 120 at two units is no breach;
  // 160 at one unit is, and it's reported for that unit
  const perStation = await sp.evaluate(() => {
    const keep = { siteLimits, siteStations, siteDevices };
    // (Unit 2's 120 is this visit's check, so re-saving it as 160 replaces it; an earlier check this month would add to it)
    const now = Date.now(), dev = (bc, name, n) => ({ barcode_id: bc, locationName: name, deviceType: 'Flying Insect Monitoring', history: [{ at: now - 60000, thisVisit: bc === 'U2', pests: [{ species: 'Midge', count: n }] }] });
    siteLimits = [{ id: 'LM', name: 'Food hall', rules: [{ species: 'Midge', max: 150 }] }];
    siteStations = new Map([['U1', { barcode: 'U1', limit_id: 'LM' }], ['U2', { barcode: 'U2', limit_id: 'LM' }]]);
    siteDevices = [dev('U1', 'Unit 1', 120), dev('U2', 'Unit 2', 120)];
    const together = allLimitTotals(null, null, sitePestRecords()).filter(x => x.total > x.rule.max).length;
    const hit = limitsHitBy('U2', 'LM', 'Midge', 160).map(x => `${x.name}:${x.total}/${x.rule.max}`);
    siteLimits = keep.siteLimits; siteStations = keep.siteStations; siteDevices = keep.siteDevices;
    return { together, hit };
  });
  ok(perStation.together === 0 && perStation.hit.join() === 'Unit 2:160/150', 'service app: critical limits are per station (two units under 150 each is no breach; 160 at one unit breaches that unit)', perStation);
  const folders = await api(b2)('site_document_folders', { op: 'select', filters: [['client_id', 'eq', sid]] });
  ok((folders.data || []).some(f => f.name === 'Meeting notes') && !(folders.data || []).some(f => f.name === 'Meetings'), 'documents: the Meeting notes folder (not Meetings)', folders);
  ok(lc.errors.length === 0, 'critical limits: no errors', lc.errors);

  // ---------- Tick-box filters, Third line breaches, and the heat map on floor plans (all three apps) ----------
  r = await api(t2)('clients', { op: 'insert', values: [{ Name: 'Heat Foods', Address: '3 Main St' }], returning: true });
  const hid = String(r.data[0].id);
  await ad.evaluate(async hid => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#e2e8f0'; g.fillRect(0, 0, 400, 300); g.strokeStyle = '#334155'; g.lineWidth = 6; g.strokeRect(20, 20, 360, 260);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    const up = await _supabase.storage.from(PHOTO_BUCKET).upload(hid + '/plan-heat.png', blob, { contentType: 'image/png', upsert: true });
    if (up.error) throw new Error(up.error.message);
  }, hid);
  await api(t2)('site_maps', { op: 'insert', values: [{ id: 'mapH', client_id: hid, name: 'Ground floor', image_path: hid + '/plan-heat.png' }] });
  const hst = (id, b, name, type, x, y) => ({ id, client_id: hid, barcode: b, name, type, map_id: 'mapH', pin_x: x, pin_y: y });
  await api(t2)('stations', { op: 'insert', values: [hst('hs1', 'RB-H1', 'Kitchen bait', 'Internal Toxic Rodent Station', .25, .3), hst('hs2', 'RB-H2', 'Store trap', 'Internal Non-Toxic Rodent Station', .7, .6),
    hst('hs3', 'RB-H3', 'Yard bait', 'External Toxic Rodent Station', .5, .9), hst('hs4', 'ILT-H4', 'Dock ILT', 'Flying Insect Monitoring', .8, .2), hst('hs5', 'RB-H5', 'Office trap', 'Internal Non-Toxic Rodent Station', .1, .8)] });
  const hlg = (b, name, ty, days, p) => ({ client_id: Number(hid), barcode_id: b, payload: Object.assign({ locationName: name, deviceType: ty, activityLevel: 'None', technician: 'Tina Tech', servicedAt: new Date(Date.now() - days * 86400000).toISOString() }, p) });
  await api(t2)('service_logs', { op: 'insert', values: [hlg('RB-H1', 'Kitchen bait', 'Internal Toxic Rodent Station', 5, { activityLevel: 'Medium' }),
    hlg('RB-H2', 'Store trap', 'Internal Non-Toxic Rodent Station', 10, { activityLevel: 'Caught', speciesCaught: 'Rat', pestCount: 2 }),
    hlg('RB-H2', 'Store trap', 'Internal Non-Toxic Rodent Station', 400, { activityLevel: 'Caught', speciesCaught: 'Mice', pestCount: 1 }),
    hlg('RB-H3', 'Yard bait', 'External Toxic Rodent Station', 5, { activityLevel: 'High' }),
    hlg('ILT-H4', 'Dock ILT', 'Flying Insect Monitoring', 5, { activityLevel: 'Caught', speciesCaught: 'House Fly', pestCount: 5 }),
    hlg('RB-H5', 'Office trap', 'Internal Non-Toxic Rodent Station', 5, {})] });
  await api(b2)('client_access', { op: 'insert', values: [{ email: 'cara@acme.test', client_id: hid }] });
  const hp = await newPage(browser, await session('cara@acme.test'), 390);
  await hp.goto(`${BASE}/client.html#/site/${hid}/reports`); await sleep(3500);
  const tableStations = () => hp.evaluate(() => Array.from(document.querySelectorAll('.pr-tbl tbody tr')).map(tr => (tr.querySelector('.pr-link b') || {}).textContent).filter(Boolean));
  // a tick-box list: open it, tick some (type to search), Done
  const tickIn = (label, values) => hp.evaluate(([label, values]) => {
    const f = Array.from(document.querySelectorAll('.pr-f')).find(x => x.firstElementChild && x.firstElementChild.textContent.trim() === label);
    f.querySelector('.pr-combo-btn').click();
    values.forEach(v => { const o = document.querySelector(`.pr-combo-pop .pr-combo-opt[data-v="${v}"]`); if (o) o.click(); });
    const btn = f.querySelector('.pr-combo-btn').textContent;
    document.querySelector('.pr-combo-pop [data-act=done]').click();
    return btn;
  }, [label, values]);
  // Third line breaches: the internal rodent stations only, the ones with rodent activity
  await hp.evaluate("PR.show(state.prBox, 'third')"); await sleep(600);
  const third = await hp.evaluate(() => ({ title: (document.querySelector('.pr-h') || {}).textContent, types: (() => { const f = Array.from(document.querySelectorAll('.pr-f')).find(x => /^Station type/.test(x.textContent.trim())); return JSON.parse(f.querySelector('.pr-combo').dataset.items).map(x => x[1]); })(), kpi: (document.querySelector('.pr-kpi-v') || {}).textContent }));
  const thirdRows = await tableStations();
  ok(/Third line breaches/.test(third.title) && third.types.length && third.types.every(t => /Internal/.test(t) && /Rodent/.test(t)), 'third line breaches: only the internal rodent station types (toxic and non-toxic)', third);
  ok(thirdRows.length === 2 && thirdRows.includes('Kitchen bait') && thirdRows.includes('Store trap') && third.kpi === '2', 'third line breaches: the internal stations with activity (not the external one, not a quiet one, not one outside the period)', { thirdRows, third });
  await tickIn('Rodent', ['Rat']); await sleep(500);
  ok(JSON.stringify(await tableStations()) === '["Store trap"]', 'third line breaches: ticking Rat shows only the stations that caught a rat', await tableStations());
  await hp.screenshot({ path: SHOTS + '/third-line.png', fullPage: true });
  // Pests found: tick two station types (nothing ticked = all)
  await hp.evaluate("PR.show(state.prBox, 'pests', { pest: [] })"); await sleep(600);
  const allPestRows = await tableStations();
  await hp.evaluate(() => { const f = Array.from(document.querySelectorAll('.pr-f')).find(x => /^Station type/.test(x.textContent.trim())); f.querySelector('.pr-combo-btn').click(); });
  await sleep(200);
  const pop = await hp.evaluate(() => { const q = document.querySelector('.pr-combo-pop .pr-combo-q'); q.value = 'flying'; q.dispatchEvent(new Event('input')); return { shown: Array.from(document.querySelectorAll('.pr-combo-pop .pr-combo-opt')).map(x => x.textContent.trim()), boxes: document.querySelectorAll('.pr-combo-pop .pr-combo-box').length }; });
  ok(pop.shown.length >= 1 && pop.shown.every(t => /flying/i.test(t)) && pop.boxes === pop.shown.length, 'tick-box list: a tick box on each, and typing searches it', pop);
  await hp.screenshot({ path: SHOTS + '/tick-list.png' });
  await hp.evaluate(() => { document.querySelector('.pr-combo-pop [data-act=done]').click(); });
  const btnTxt = await tickIn('Station type', ['Flying Insect Monitoring']); await sleep(500);
  const oneType = await tableStations();
  await tickIn('Station type', ['Internal Non-Toxic Rodent Station']); await sleep(500);
  const typed = await tableStations(), label = await hp.evaluate(() => Array.from(document.querySelectorAll('.pr-f')).find(x => /^Station type/.test(x.textContent.trim())).querySelector('.pr-combo-btn').textContent);
  ok(allPestRows.length === 2 && JSON.stringify(oneType) === '["Dock ILT"]' && typed.length === 2 && typed.includes('Dock ILT') && typed.includes('Store trap') && label === '2 types' && btnTxt === 'All types', 'tick-box list: two station types ticked shows both (and the button says "2 types")', { allPestRows, oneType, typed, label, btnTxt });
  // the heat map on the Client Portal floor plan
  await hp.evaluate("setTab('plans')"); await sleep(600);
  await hp.evaluate("planId = 'mapH'; renderPlans()"); await sleep(1500);
  await hp.evaluate("togglePlanHeat()"); await sleep(500);
  const px = (sel, x, y) => hp.evaluate(([sel, x, y]) => { const c = document.querySelector(sel); if (!c) return null; return c.getContext('2d').getImageData(Math.round(x * c.width), Math.round(y * c.height), 1, 1).data[3]; }, [sel, x, y]);
  const heat1 = await hp.evaluate(() => ({ layer: !!document.querySelector('#planStage canvas.heat-layer'), sum: (document.querySelector('#planHeatBox .heat-sum') || {}).textContent }));
  ok(heat1.layer && /^4 stations with activity · most at Dock ILT/.test(heat1.sum) && (await px('#planStage .heat-layer', .25, .3)) > 0 && !(await px('#planStage .heat-layer', .1, .8)), 'portal heat map: drawn over the plan, hot where there was activity and not at a quiet station', heat1);
  await hp.screenshot({ path: SHOTS + '/heat-portal-390.png', fullPage: true });
  // the plan area is the plan's own shape (no grey bands at the sides); station names are in the pin's colour with no dark box
  const shape = await hp.evaluate(() => { const v = document.getElementById('planView').getBoundingClientRect(), l = document.querySelector('#planStage .plan-pin-label'), pin = l.parentElement.querySelector('span'), cs = getComputedStyle(l);
    return { page: !!document.querySelector('#planStage canvas.pz-page') && !!document.querySelector('#planBox .plan-pin'), w: v.width, h: v.height, ih: innerHeight, color: cs.color, pin: getComputedStyle(pin).backgroundColor, bg: cs.backgroundColor }; });
  ok(Math.abs(shape.h - Math.max(240, Math.min(shape.w * 2480 / 3508, shape.ih * .85))) < 4 && shape.page && shape.color === shape.pin && shape.bg === 'rgba(0, 0, 0, 0)', 'floor plan: shown as the Pest map page (header, plan, legend) filling its area, with tappable pins; station names in the pin colour with no box', shape);
  // the pests are a drop-down with tick boxes and a search; it stays open while ticking
  await hp.click('#planHeatBox .heat-dd-btn'); await sleep(200);
  await hp.fill('#planHeatBox .heat-dd-pop input[type=search]', 'ra'); await sleep(100);
  const ddShown = await hp.evaluate(() => Array.from(document.querySelectorAll('#planHeatBox .heat-list label')).filter(l => l.style.display !== 'none').map(l => l.textContent.trim()));
  await hp.screenshot({ path: SHOTS + '/heat-dropdown-390.png' });
  await hp.click('#planHeatBox .heat-list input[value="Rat"]'); await sleep(300);
  const dd = await hp.evaluate(() => ({ open: !document.querySelector('#planHeatBox .heat-dd-pop').hidden, btn: document.querySelector('#planHeatBox .heat-dd-btn').textContent, q: document.querySelector('#planHeatBox .heat-dd-pop input[type=search]').value }));
  ok(JSON.stringify(ddShown) === '["Rat"]' && dd.open && dd.btn === 'Rat' && dd.q === 'ra', 'heat map: pests are a drop-down with a search and tick boxes, kept open while ticking', { ddShown, dd });
  await hp.click('#planHeatBox .heat-done'); await sleep(200);
  ok(await hp.evaluate(() => document.querySelector('#planHeatBox .heat-dd-pop').hidden), 'heat map: Done closes the pest drop-down');
  // the plan can be zoomed and dragged; a drag doesn't open a station, a tap on a pin does
  const zoomOf = () => hp.evaluate(() => { const m = /scale\(([\d.]+)\)/.exec(document.getElementById('planStage').style.transform); return m ? Number(m[1]) : null; });
  const z0 = await zoomOf();
  await hp.click('#planView .pz-ctl [data-pz=in]'); await sleep(200);
  const z1 = await zoomOf();
  await hp.evaluate(() => document.getElementById('planView').scrollIntoView({ block: 'center' })); await sleep(200);
  const box = await hp.evaluate(() => { const r = document.getElementById('planView').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const tr0 = await hp.evaluate(() => document.getElementById('planStage').style.transform);
  await hp.mouse.move(box.x - 60, box.y); await hp.mouse.down(); await hp.mouse.move(box.x + 40, box.y + 20, { steps: 8 }); await hp.mouse.up(); await sleep(300);
  const tr1 = await hp.evaluate(() => document.getElementById('planStage').style.transform);
  const opened = await hp.evaluate(() => !document.getElementById('modal').classList.contains('hidden'));
  ok(z0 > 0 && z1 > z0 * 1.3 && tr0 !== tr1 && !opened, 'floor plan: + zooms in, dragging moves it (and does not open a station)', { z0, z1, tr0, tr1, opened });
  await hp.click('#planView .pz-ctl [data-pz=full]'); await sleep(300);
  const full = await hp.evaluate(() => { const r = document.getElementById('planView').getBoundingClientRect(); return { full: document.getElementById('planView').classList.contains('pz-full'), w: r.width, h: r.height }; });
  await hp.screenshot({ path: SHOTS + '/plan-full-390.png' });
  await hp.keyboard.press('Escape'); await sleep(200);
  ok(full.full && full.w === 390 && full.h > 800 && !(await hp.evaluate(() => document.getElementById('planView').classList.contains('pz-full'))), 'floor plan: full screen fills the screen, Escape closes it', full);
  await hp.click('#planView .pz-ctl [data-pz=fit]'); await sleep(200);
  await hp.evaluate("planHeatSet('pests', [])"); await hp.evaluate("planHeatSet('pest', 'Rat', true)"); await sleep(300);
  const heat2 = await hp.evaluate(() => (document.querySelector('#planHeatBox .heat-sum') || {}).textContent);
  ok(/^1 station with activity · most at Store trap/.test(heat2) && (await px('#planStage .heat-layer', .7, .6)) > 0 && !(await px('#planStage .heat-layer', .25, .3)), 'portal heat map: ticking a pest shows only its activity', heat2);
  await hp.evaluate("planHeatSet('period', '1m')"); await sleep(300);
  ok(/^1 station/.test(await hp.evaluate(() => document.querySelector('#planHeatBox .heat-sum').textContent)), 'portal heat map: the time frame can be changed');
  await hp.setViewportSize({ width: 1280, height: 900 }); await sleep(400);
  await hp.screenshot({ path: SHOTS + '/heat-portal-1280.png', fullPage: true });
  // the critical limits box stays readable with lots of breaches: a chip per insect, the first few lines, then Show all
  await api(b2)('site_limits', { op: 'insert', values: [{ id: 'limH', client_id: hid, name: 'Production', rules: [{ species: 'Blowfly', max: 5 }, { species: 'House Fly', max: 10 }] }] });
  await api(t2)('stations', { op: 'insert', values: Array.from({ length: 8 }, (_, i) => ({ id: 'hm' + i, client_id: hid, barcode: 'ILT-M' + i, name: 'Line ' + (i + 1) + ' ILT', type: 'Flying Insect Monitoring', limit_id: 'limH' })) });
  await api(t2)('service_logs', { op: 'insert', values: Array.from({ length: 8 }, (_, i) => hlg('ILT-M' + i, 'Line ' + (i + 1) + ' ILT', 'Flying Insect Monitoring', 1, { activityLevel: 'Caught', speciesCaught: 'Blowfly', pestCount: 6 + i, morePests: i < 3 ? [{ species: 'House Fly', count: 12 }] : [] })) });
  await hp.evaluate('loadSite && loadSite(state.site.id)').catch(() => {}); await hp.reload(); await sleep(3500);
  await hp.evaluate("openLimitReport('ILT-M0')"); await sleep(800);
  await hp.evaluate("PR.show(state.prBox, 'limits', { station: [] })"); await sleep(600);
  const ab = await hp.evaluate(() => ({ chips: Array.from(document.querySelectorAll('.pr-ab-chip')).map(c => c.textContent.trim()), rows: document.querySelectorAll('.pr-ab-list > .pr-ab-row:not(.pr-ab-head)').length, more: (document.querySelector('.pr-ab-more summary') || {}).textContent, first: (document.querySelector('.pr-ab-list > .pr-ab-row:not(.pr-ab-head)') || {}).innerText }));
  await hp.evaluate(() => document.querySelector('.pr-alert').scrollIntoView()); await hp.screenshot({ path: SHOTS + '/limits-box-1280.png' });
  await hp.setViewportSize({ width: 390, height: 900 }); await sleep(300); await hp.evaluate(() => document.querySelector('.pr-alert').scrollIntoView()); await hp.screenshot({ path: SHOTS + '/limits-box-390.png' }); await hp.setViewportSize({ width: 1280, height: 900 });
  ok(ab.chips.some(c => /Blowfly · 8 stations over/.test(c)) && ab.chips.some(c => /House Fly · 3 stations over/.test(c)) && ab.rows === 5 && ab.more === 'Show all 11 breaches' && /Line 8 ILT/.test(ab.first), 'critical limits box: a chip per insect, 5 lines (the most over first), Show all for the rest', ab);
  await hp.evaluate(() => document.querySelector('.pr-ab-chip[data-p="House Fly"]').click()); await sleep(400);
  ok((await hp.evaluate(() => document.querySelectorAll('.pr-lim').length)) === 3, 'critical limits box: tapping an insect chip shows just that insect');
  ok(hp.errors.length === 0, 'tick-box filters and portal heat map: no errors', hp.errors);
  // Admin: the site page shows its floor plans with the heat map
  await ad.reload(); await sleep(4000);
  await ad.evaluate(id => openAdminSite(id), hid); await sleep(3500);
  const adHeat = await ad.evaluate(() => ({ layer: !!document.querySelector('#asPlanStage canvas.heat-layer'), pins: document.querySelectorAll('#asPlanStage .as-pin').length, sum: (document.querySelector('#asHeatBox .heat-sum') || {}).textContent }));
  ok(adHeat.layer && adHeat.pins === 5 && /^4 stations with activity/.test(adHeat.sum), 'admin heat map: the site page shows the floor plan, its stations and the heat map', adHeat);
  await ad.evaluate(() => document.getElementById('asPlans').scrollIntoView()); await ad.screenshot({ path: SHOTS + '/heat-admin.png' });
  // Service App: the Heat map tick box on the floor plan
  const hs = await newPage(browser, t2, 390);
  await hs.goto(BASE + '/index.html'); await hs.waitForSelector(`.site-card[data-id='${hid}']`, { timeout: 20000 }).catch(() => {});
  await hs.click(`.site-card[data-id='${hid}']`); await hs.waitForSelector('#siteLandingDashboard:not(.hidden)', { timeout: 20000 }); await sleep(2500);
  await hs.evaluate("openMapModal()"); await sleep(2000);
  await hs.click('#mapHeatOn'); await sleep(500);
  const svHeat = await hs.evaluate(() => ({ layer: !!document.querySelector('#mapStage canvas.heat-layer'), sum: (document.querySelector('#mapHeatBox .heat-sum') || {}).textContent, pests: Array.from(document.querySelectorAll('#mapHeatBox .heat-list input')).map(i => i.value) }));
  ok(svHeat.layer && /^4 stations with activity/.test(svHeat.sum) && svHeat.pests.includes('Rat') && svHeat.pests.includes('House Fly'), 'service app heat map: the Heat map tick box colours the plan, with pests to tick', svHeat);
  await hs.screenshot({ path: SHOTS + '/heat-service-390.png' });
  ok(hs.errors.length === 0 && ad.errors.length === 0, 'heat map in Admin and the Service App: no errors', { hs: hs.errors, ad: ad.errors });
} catch (e) { fails++; console.log('ERROR', e); }
finally {
  await browser.close();
  srv.stop();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
