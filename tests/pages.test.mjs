// Every page: each tab, report and Admin page of the three apps (phone and computer width) opened with some realistic data,
// and a station saved and a visit taken to the sign step - any error on the way fails the test.
import path from 'node:path';
import { start, idToken, playwright, STUBS_DIR, tmpDir } from './harness.mjs';
const { chromium } = playwright();
const PORT = 8097, BASE = `http://127.0.0.1:${PORT}`, KEY = 'sb-127-auth-token';
const srv = await start({ port: PORT, dataDir: tmpDir('pages') });
const STUBS = { 'cdn.tailwindcss.com': 'tailwind-real.js', 'html5-qrcode': 'qr-stub.js', 'jspdf': 'jspdf-stub.js', 'jszip': 'jszip.min.js' };
const session = async (email, extra) => (await (await fetch(BASE + '/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: idToken(email, extra) }) })).json()).session;
const api = s => async (table, body) => (await fetch(BASE + '/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.access_token }, body: JSON.stringify(Object.assign({ table }, body)) })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dayIn = n => { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ago = n => new Date(Date.now() - n * 86400000).toISOString();
const SHOTS = tmpDir('shots');
const browser = await chromium.launch();
const all = [];
async function page(sess, w = 1280) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, serviceWorkers: 'block' });
  await ctx.addInitScript(([k, v]) => { localStorage.setItem(k, v); }, [KEY, JSON.stringify(sess)]);
  const p = await ctx.newPage(); p.where = '';
  p.on('pageerror', e => all.push(`[${p.app} ${p.where}] PAGEERROR ${e.message}`));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|favicon|net::ERR/.test(m.text())) all.push(`[${p.app} ${p.where}] CONSOLE ${m.text().slice(0, 300)}`); });
  p.on('dialog', d => d.dismiss());
  await p.route('**/*', r => { const u = r.request().url(); for (const [k, f] of Object.entries(STUBS)) if (u.includes(k)) return r.fulfill({ path: path.join(STUBS_DIR, f), contentType: 'application/javascript' }); return u.startsWith(BASE) ? r.continue() : r.fulfill({ status: 404, body: '' }); });
  return p;
}
let steps = 0; const step = async (p, where, fn) => { steps++; p.where = where; try { await fn(); } catch (e) { all.push(`[${p.app} ${where}] THROW ${e.message.split('\n')[0]}`); } await sleep(350); };
try {
  const boss = await session('boss@example.com');
  await api(boss)('allowed_emails', { op: 'upsert', values: { email: 'tech@example.com', role: 'technician' } });
  const tech = await session('tech@example.com', { name: 'Tina Tech' });
  await api(tech)('clients', { op: 'insert', values: [{ Name: 'Acme Foods', Address: '1 Main St', services: [{ id: 's1', type: 'Routine Service', frequency: 'monthly', last_done: '2026-09-01' }] }] });
  await api(boss)('site_limits', { op: 'insert', values: [{ id: 'L1', client_id: '1', name: 'Kitchen', rules: [{ species: 'Fly', max: 5 }] }] });
  const types = ['Internal Toxic Rodent Station', 'External Non-Toxic Rodent Station', 'Flying Insect Monitoring', 'Crawling Insect Monitoring'];
  const st = [], logs = [];
  for (let i = 0; i < 12; i++) st.push({ id: 'st' + i, client_id: '1', barcode: 'B' + i, name: 'Station ' + i, type: types[i % 4], limit_id: i % 4 === 2 ? 'L1' : null });
  await api(tech)('stations', { op: 'insert', values: st });
  for (let m = 0; m < 14; m++) for (let i = 0; i < 12; i++) {
    const at = new Date(Date.now() - m * 30 * 86400000 - 86400000 - i * 60000).toISOString(), t = types[i % 4];
    const pest = t.includes('Flying') ? 'Fly' : t.includes('Crawling') ? 'Cockroach' : (m % 3 ? 'Rat' : 'None');
    logs.push({ client_id: 1, barcode_id: 'B' + i, created_at: at, payload: { locationName: 'Station ' + i, deviceType: t, technician: 'Tina Tech', servicedAt: at, activityLevel: pest === 'None' ? 'None' : t.includes('Toxic') ? 'Low' : 'Caught', speciesCaught: pest, pestCount: pest === 'None' ? undefined : (i + m) % 9 + 1, prepUsed: t.includes('Toxic') ? 'Bait block' : 'None', quantity: t.includes('Toxic') ? 2 : undefined, quantityUnit: 'each', batchNumber: 'X1', clientRef: `r${m}-${i}` } });
  }
  await api(tech)('service_logs', { op: 'insert', values: logs });
  const visits = []; for (let m = 0; m < 14; m++) { const at = new Date(Date.now() - m * 30 * 86400000 - 86400000 + 3600000).toISOString(); visits.push({ id: 'v' + m, client_id: '1', visit_type: 'Routine Service', technician: 'Tina Tech', started_at: at, completed_at: at, created_at: at }); }
  await api(tech)('visits', { op: 'insert', values: visits });
  await api(tech)('recommendations', { op: 'insert', values: [{ id: 'rec-1', client_id: '1', station_barcode: 'B1', station_name: 'Station 1', text: 'Seal the gap', raised_by: 'Tina Tech' }] });
  await api(tech)('pest_sightings', { op: 'insert', values: [{ id: 'ps1', client_id: '1', pest: 'Rat', location: 'Dock', urgency: 'Routine', reported_by: 'Jane', seen_at: new Date().toISOString() }] });
  await api(boss)('site_documents', { op: 'insert', values: [{ id: 'd1', client_id: '1', title: 'Pest plan', category: 'Pest management plan', folder: 'Pest management plan', file_path: '1/x.pdf', expires_on: dayIn(15) }] });
  await api(tech)('site_buildings', { op: 'insert', values: [{ id: 'bA', client_id: '1', name: 'Main' }] });
  await api(tech)('site_maps', { op: 'insert', values: [{ id: 'm1', client_id: '1', name: 'Ground', building_id: 'bA' }] });
  // floor plans due for their yearly check: one within a month, one overdue
  await api(tech)('site_maps', { op: 'insert', values: [{ id: 'm2', client_id: '1', name: 'Old plan', building_id: 'bA', created_at: ago(500), updated_at: ago(350) }, { id: 'm3', client_id: '1', name: 'Ancient plan', created_at: ago(500), updated_at: ago(400) }] });

  // ---------- Client Portal (staff) ----------
  for (const w of [1280, 390]) {
    const cp = await page(boss, w); cp.app = 'portal' + w;
    await step(cp, 'open', async () => { await cp.goto(`${BASE}/client.html#/site/1/overview`); await cp.waitForFunction(() => typeof state !== 'undefined' && state.model, null, { timeout: 30000 }); });
    for (const t of ['overview', 'recs', 'sightings', 'reports', 'visits', 'documents', 'plans', 'techs']) await step(cp, 'tab ' + t, () => cp.evaluate(t => setTab(t), t));
    await step(cp, 'expiry notifications', async () => {
      const keys = await cp.evaluate(async () => { await loadAllDocs(); return bellItems(true).map(i => i.key); });
      if (!keys.some(k => /^plan:m2:.*:m$/.test(k)) || !keys.some(k => /^plan:m3:.*:x$/.test(k)) || !keys.includes(`doc:d1:${dayIn(15)}:m`) || keys.some(k => k.startsWith('plan:m1:')))
        all.push(`[${cp.app}] the floor plan / document expiry notifications are wrong: ${keys.join(' ')}`);
      if (w === 390) { await cp.evaluate(() => toggleBell()); await sleep(400); await cp.screenshot({ path: path.join(SHOTS, 'portal-bell-390.png') }); await cp.evaluate(() => toggleBell()); }
    });
    const reps = await cp.evaluate(() => PR.REPORTS.map(r => r.id));
    await cp.evaluate(() => setTab('reports'));
    for (const r of reps) await step(cp, 'report ' + r, () => cp.evaluate(r => PR.show(state.prBox, r), r));
    await step(cp, 'bell', () => cp.evaluate(() => { document.getElementById('bellBtn').click(); }));
    await step(cp, 'settings', () => cp.evaluate(() => openSettings()));
    await step(cp, 'whats new', () => cp.evaluate(() => openWhatsNew()));
    await step(cp, 'visit report', () => cp.evaluate(() => openVisit(state.model.visits[state.model.visits.length - 1].id)));
    await step(cp, 'station', () => cp.evaluate(() => showStation('B2')));
    await cp.context().close();
  }
  // ---------- Admin ----------
  const ad = await page(boss); ad.app = 'admin';
  await step(ad, 'open', async () => { await ad.goto(`${BASE}/admin.html`); await ad.waitForFunction(() => typeof clientsData !== 'undefined' && clientsData.length, null, { timeout: 30000 }); });
  for (const t of ['overview', 'sites', 'team', 'clients', 'services', 'documents', 'contacts', 'limits', 'reports', 'lists', 'days', 'activity', 'exports', 'settings']) await step(ad, 'tab ' + t, () => ad.evaluate(t => openAdmin(t), t));
  await step(ad, 'site page', async () => { await ad.evaluate(() => { openAdmin('sites'); openAdminSite('1'); }); await sleep(2500); });
  await step(ad, 'reports for site', async () => { await ad.evaluate(() => { openAdmin('reports'); const s = document.getElementById('repSite'); s.value = '1'; loadAdminReports(); }); await sleep(2000); });
  await step(ad, 'whats new', () => ad.evaluate(() => openWhatsNew()));
  await step(ad, 'needs attention', async () => {
    await ad.evaluate(() => { try { closeInfoModal(); } catch (e) {} openAdmin("overview"); });
    const t = await ad.evaluate(() => document.getElementById('adminAttention').textContent);
    if (!/floor plan "Old plan" is due for its yearly check/.test(t) || !/"Ancient plan" is overdue/.test(t) || !/expires within a month/.test(t) || !/New/.test(t)) all.push(`[admin] Needs attention misses the floor plans or the document: ${t.slice(0, 400)}`);
    await ad.screenshot({ path: path.join(SHOTS, 'admin-attention-1280.png') });
    await ad.evaluate(() => document.getElementById('adminSeenAll').click()); await sleep(1000);
    const after = await ad.evaluate(async () => ({ n: document.getElementById('adminAttentionNew').textContent, t: document.getElementById('adminAttention').textContent, seen: ((await _supabase.rpc('get_my_prefs')).data.seen || {}).staff_bell || [] }));
    if (after.n || /New/.test(after.t) || !after.seen.some(k => k.startsWith('plan:m2:'))) all.push(`[admin] Mark all as seen didn't stick: ${JSON.stringify(after).slice(0, 300)}`);
  });
  await step(ad, 'data stored', async () => {
    await ad.evaluate(() => { openAdmin('sites'); closeAdminSite(); });
    await ad.waitForSelector('#adminStorage', { timeout: 15000 });
    await ad.waitForSelector(".site-card[data-id='1'] .site-data", { timeout: 15000 });
    const pill = await ad.textContent(".site-card[data-id='1'] .site-data");
    if (!/records/.test(pill)) all.push(`[admin] the site card's data stored: ${pill}`);
    await ad.evaluate(() => openAdminSite('1'));
    await ad.waitForFunction(() => /Station checks/.test(document.getElementById('asData').textContent) && /168/.test(document.getElementById('asData').textContent), null, { timeout: 15000 });
  });
  for (const w of [390, 1280]) await step(ad, 'data stored ' + w, async () => {
    await ad.setViewportSize({ width: w, height: 900 });
    await ad.evaluate(() => closeAdminSite()); await sleep(600);
    await ad.screenshot({ path: path.join(SHOTS, `admin-sites-${w}.png`) });
    await ad.evaluate(() => openAdminSite('1')); await sleep(1500);
    await ad.evaluate(() => document.getElementById('asData').scrollIntoView()); await sleep(300);
    await ad.screenshot({ path: path.join(SHOTS, `admin-site-data-${w}.png`) });
  });
  // ---------- Service App ----------
  for (const w of [1280, 390]) {
    const sp = await page(tech, w); sp.app = 'service' + w;
    await step(sp, 'open', async () => { await sp.goto(`${BASE}/index.html`); await sp.waitForSelector(".site-card[data-id='1']", { timeout: 30000 }); });
    await step(sp, 'site', async () => { await sp.click(".site-card[data-id='1']"); await sp.waitForSelector('#siteLandingDashboard:not(.hidden)', { timeout: 30000 }); await sleep(2000); });
    await step(sp, 'map', () => sp.evaluate(() => openMapModal()));
    await step(sp, 'map close', () => sp.evaluate(() => closeMapModal && closeMapModal()));
    await step(sp, 'station overview', () => sp.evaluate(() => openStationOverview('B2')));
    await step(sp, 'notifications', () => sp.evaluate(() => openNotifModal()));
    await step(sp, 'profile', () => sp.evaluate(() => openProfileModal()));
    await step(sp, 'whats new', () => sp.evaluate(() => openWhatsNew()));
    await step(sp, 'start visit', async () => { await sp.evaluate(() => { chooseVisitType = async () => 'Routine Service'; document.getElementById('startServiceLabel').click(); }); await sleep(1500); });
    await step(sp, 'scan', () => sp.evaluate(() => handleScannedBarcode('B3')));
    await step(sp, 'save', () => sp.evaluate(() => { return saveStationServiceRecord(); }));
    await step(sp, 'complete', async () => { await sp.evaluate(() => { askChoice = async () => 'b'; return openCompleteVisitModal(); }); });
    await step(sp, 'sign tab', () => sp.evaluate(() => { document.getElementById('closingSiteNotes').value = 'ok'; setCloseTab('sign'); }));
    const review = await sp.evaluate(() => (document.getElementById('signOffReview').textContent || ''));
    if (!/Stations scanned \(1 of 12\)/.test(review)) all.push(`[${sp.app}] the sign step doesn't count the saved station: ${review.slice(0, 200)}`);
    await step(sp, 'close modal', () => sp.evaluate(() => closeCompleteVisitModal()));
    await step(sp, 'expiry notifications', async () => {
      await sp.evaluate(async () => { document.querySelectorAll(".overlay:not(#notifModal)").forEach(o => o.classList.add("hidden")); await loadBellExtras(); await openNotifModal(); });
      const got = await sp.evaluate(() => ({ t: document.getElementById('notifList').textContent, k: Array.from(document.querySelectorAll('#notifList [data-nk]')).map(b => b.dataset.nk).filter(Boolean), n: buildNotifications().total }));
      const plan = got.k.find(k => k.startsWith('plan:m2:'));
      if (!/Floor plans due for their yearly check \(2\)/.test(got.t) || !/expires within a month/.test(got.t) || !plan || !got.k.some(k => /^plan:m3:.*:expired$/.test(k))) all.push(`[${sp.app}] the expiry notifications are missing: ${got.t.slice(0, 300)} ${got.k.join(' ')}`);
      await sp.screenshot({ path: path.join(SHOTS, `service-notifs-${w}.png`) });
      if (w === 1280) {
        if (!/New/.test(got.t)) all.push(`[${sp.app}] new notifications aren't marked New`);
        await sp.evaluate(k => document.querySelector(`#notifList [data-nk="${k}"]`).click(), plan); await sleep(1500);
        const after = await sp.evaluate(async k => ({ here: staffSeen().has(k), n: buildNotifications().total, acct: (((await _supabase.rpc('get_my_prefs')).data.seen || {}).staff_bell || []).includes(k) }), plan);
        if (!after.here || !after.acct || after.n !== got.n - 1) all.push(`[${sp.app}] tapping a notification didn't mark it seen: ${JSON.stringify(after)} (was ${got.n})`);
        await sp.evaluate(() => { try { closeMapModal(); } catch (e) {} });
      } else if (await sp.evaluate(() => document.querySelectorAll('#notifList [data-nk^="plan:m2:"] .chip-blue').length)) {
        all.push(`[${sp.app}] a notification seen on another browser shows as New again`);   // (a new browser: tapped on the other one)
      }
      await sp.evaluate(() => closeNotifModal());
    });
    await sp.context().close();
  }
  // ---------- Client Portal as a client ----------
  await api(boss)('client_users', { op: 'insert', values: { email: 'cara@acme.test', full_name: 'Cara Client' } });
  await api(boss)('client_access', { op: 'insert', values: [{ email: 'cara@acme.test', client_id: '1' }] });
  const cara = await session('cara@acme.test');
  const cc = await page(cara, 390); cc.app = 'portal-client';
  await step(cc, 'open', async () => { await cc.goto(`${BASE}/client.html#/site/1/overview`); await cc.waitForFunction(() => typeof state !== 'undefined' && state.model, null, { timeout: 30000 }); });
  for (const t of ['overview', 'recs', 'sightings', 'reports', 'visits', 'documents', 'plans', 'techs']) await step(cc, 'tab ' + t, () => cc.evaluate(t => setTab(t), t));
} catch (e) { all.push('SCRIPT ' + e.message); }
finally {
  if (steps < 70) all.push(`only ${steps} steps ran`);
  console.log(all.length ? 'FAIL every page opens with no errors\n' + all.join('\n') : `PASS every page opens with no errors (${steps} steps)`);
  console.log(`\n${all.length ? 0 : 1} passed, ${all.length ? 1 : 0} failed`);
  await browser.close(); srv.stop(); process.exit(all.length ? 1 : 0);
}
