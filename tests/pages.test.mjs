// Every page: each tab, report and Admin page of the three apps (phone and computer width) opened with some realistic data,
// and a station saved and a visit taken to the sign step - any error on the way fails the test.
import path from 'node:path';
import { start, idToken, playwright, STUBS_DIR, tmpDir } from './harness.mjs';
const { chromium } = playwright();
const PORT = 8097, BASE = `http://127.0.0.1:${PORT}`, KEY = 'sb-127-auth-token';
const srv = await start({ port: PORT, dataDir: tmpDir('pages') });
const STUBS = { 'cdn.tailwindcss.com': 'tailwind-real.js', 'html5-qrcode': 'qr-stub.js', 'jspdf': process.env.REAL_JSPDF || 'jspdf-stub.js', 'jszip': 'jszip.min.js' };
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
  await p.route('**/*', r => { const u = r.request().url(); for (const [k, f] of Object.entries(STUBS)) if (u.includes(k)) return r.fulfill({ path: path.resolve(STUBS_DIR, f), contentType: 'application/javascript' }); return u.startsWith(BASE) ? r.continue() : r.fulfill({ status: 404, body: '' }); });
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
  const visits = []; for (let m = 0; m < 14; m++) { const at = new Date(Date.now() - m * 30 * 86400000 - 86400000 + 3600000).toISOString(); visits.push(Object.assign({ id: 'v' + m, client_id: '1', visit_type: 'Routine Service', technician: 'Tina Tech', started_at: at, completed_at: at, created_at: at },
    m ? {} : { stations_added: [{ barcode: 'B11', name: 'Station 11', type: types[3] }], stations_removed: [{ barcode: 'OLD1', name: 'Old bait box', type: types[1] }] })); }
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
    await step(cp, 'floor plans open on a plan', async () => {
      await cp.evaluate(() => { planId = null; setTab('plans'); }); await sleep(1500);
      const got = await cp.evaluate(() => ({ stage: !!document.getElementById('planStage'), cards: document.querySelectorAll('.plan-card').length, pick: document.querySelectorAll('#tabBody .plan-pick-b, #tabBody .plan-pick-p').length }));
      if (!got.stage || got.cards || got.pick < 2) all.push(`[${cp.app}] the floor plans tab doesn't open on a plan with the building and plan pickers: ${JSON.stringify(got)}`);
      await cp.screenshot({ path: path.join(SHOTS, `portal-plans-${w}.png`) });
    });
    await step(cp, 'expiry notifications', async () => {
      const keys = await cp.evaluate(async () => { await loadAllDocs(); return bellItems(true).map(i => i.key); });
      if (!keys.some(k => /^plan:m2:.*:m$/.test(k)) || !keys.some(k => /^plan:m3:.*:x$/.test(k)) || !keys.includes(`doc:d1:${dayIn(15)}:m`) || keys.some(k => k.startsWith('plan:m1:')))
        all.push(`[${cp.app}] the floor plan / document expiry notifications are wrong: ${keys.join(' ')}`);
      if (w === 390) { await cp.evaluate(() => toggleBell()); await sleep(400); await cp.screenshot({ path: path.join(SHOTS, 'portal-bell-390.png') }); await cp.evaluate(() => toggleBell()); }
    });
    const reps = await cp.evaluate(() => PR.REPORTS.map(r => r.id));
    await cp.evaluate(() => setTab('reports'));
    for (const r of reps) await step(cp, 'report ' + r, () => cp.evaluate(r => PR.show(state.prBox, r), r));
    await step(cp, 'smooth line graphs', async () => {
      await cp.evaluate(() => PR.show(state.prBox, 'trend')); await sleep(500);
      const got = await cp.evaluate(() => ({ curves: Array.from(document.querySelectorAll('.pr-svg path.pr-line')).filter(p => /C/.test(p.getAttribute('d'))).length, polylines: document.querySelectorAll('.pr-svg polyline').length }));
      if (!got.curves || got.polylines) all.push(`[${cp.app}] the line graphs aren't smooth: ${JSON.stringify(got)}`);
      // hovering a point (one with records) shows its pop-up: the total, the pests and the latest checks with date and station
      const pt = await cp.evaluate(() => { const g = Array.from(document.querySelectorAll('.pr-svg .pr-pt')).reverse().find(x => !/: 0$/.test(x.getAttribute('aria-label'))); if (!g) return null; g.setAttribute('data-test-pt', '1'); g.scrollIntoView({ block: 'center' }); return g.getAttribute('aria-label'); });
      if (pt) {
        await cp.hover('[data-test-pt="1"] .pr-hit', { force: true }); await sleep(400);
        const tip = await cp.evaluate(() => { const t = document.querySelector('.pr-tip.on'); return t ? t.textContent : ''; });
        if (!/caught/.test(tip) || !/check/.test(tip) || !/Station \d/.test(tip) || !/\d{4}/.test(tip)) all.push(`[${cp.app}] hovering a graph point doesn't show its details: "${tip.slice(0, 200)}" (${pt})`);
        await cp.screenshot({ path: path.join(SHOTS, `portal-tip-${w}.png`) });
        await cp.mouse.move(1, 1);
      } else all.push(`[${cp.app}] no graph points to hover`);
      await cp.screenshot({ path: path.join(SHOTS, `portal-trend-${w}.png`) });
      await cp.evaluate(() => PR.show(state.prBox, 'third')); await sleep(400);
      if (await cp.evaluate(() => document.querySelectorAll('#tabBody .pr-alert:not(.pr-alert-ok)').length)) all.push(`[${cp.app}] the third line report still has the red card on top`);
    });
    await step(cp, 'bell', () => cp.evaluate(() => { document.getElementById('bellBtn').click(); }));
    await step(cp, 'bell seen stays listed', async () => {
      const before = await cp.evaluate(() => document.querySelectorAll('#bellPanel [data-key]').length);
      await cp.evaluate(() => markAllBellSeen());
      const after = await cp.evaluate(() => ({ n: document.querySelectorAll('#bellPanel [data-key]').length, count: document.getElementById('bellCount').classList.contains('hidden'), isNew: document.querySelectorAll('#bellPanel .chip-blue').length }));
      if (!before || after.n !== before || !after.count || after.isNew) all.push(`[${cp.app}] seen notifications should stay in the bell list without a count: ${before} -> ${JSON.stringify(after)}`);
      await cp.evaluate(() => { $('bellPanel').classList.add('hidden'); });
    });
    await step(cp, 'settings', () => cp.evaluate(() => openSettings()));
    await step(cp, 'whats new', () => cp.evaluate(() => openWhatsNew()));
    await step(cp, 'visit report', () => cp.evaluate(() => openVisit(state.model.visits[state.model.visits.length - 1].id)));
    await step(cp, 'visit report colours', async () => {
      const got = await cp.evaluate(() => ({ cls: Array.from(document.querySelectorAll('#modalBody tr[class*="lvl-"]')).map(r => r.className.match(/lvl-\w+/)[0]), t: document.getElementById('modalBody').textContent }));
      const lv = await cp.evaluate(() => [['None'], ['Low'], ['Medium'], ['High'], ['Caught'], ['None', 'Caught'], ['Low', 'High'], [], ['Taken']].map(a => PVR.level(a)).concat([PVR.level(['Low'], true), PVR.level(['Caught'], true)]).join());
      if (lv !== 'green,green,amber,red,amber,amber,red,green,amber,red,red') all.push(`[${cp.app}] the activity colours are wrong: ${lv}`);
      ['lvl-green', 'lvl-amber', 'lvl-red'].forEach(c => { if (!got.cls.includes(c)) all.push(`[${cp.app}] the visit report has no ${c} rows: ${got.cls.join(' ')}`); });
      if (!/Stations installed on this visit \(1\)[\s\S]*Station 11[\s\S]*Stations removed on this visit \(1\)[\s\S]*Old bait box/.test(got.t)) all.push(`[${cp.app}] the visit report doesn't list the stations installed and removed`);
      await cp.screenshot({ path: path.join(SHOTS, `portal-visit-${w}.png`) });
      if (w === 1280 && process.env.REAL_JSPDF) {
        const [dl] = await Promise.all([cp.waitForEvent('download'), cp.evaluate(() => downloadVisitPdf(state.model.visits[state.model.visits.length - 1].id))]);
        await dl.saveAs(path.join(SHOTS, 'visit-report.pdf'));
        const [dl2] = await Promise.all([cp.waitForEvent('download'), cp.evaluate(() => PVR.build({ siteName: 'Long breach list', completed: Date.now(), type: 'Routine Service',
          breaches: Array.from({ length: 1500 }, (_, i) => `A-ILT ${String(i + 1).padStart(4, '0')}`),
          entries: Array.from({ length: 30 }, (_, i) => ({ name: 'Station ' + i, barcode: 'B' + i, type: 'Flying Insect Monitoring', activity: ['None', 'Low', 'Medium', 'High', 'Caught'][i % 5], breach: i === 4, pests: '' })) }))]);
        await dl2.saveAs(path.join(SHOTS, 'long-breaches.pdf'));
      }
      if (await cp.evaluate(() => !!(window.__pdf && window.jspdf && window.__pdf.pos))) {
        // a long breach list carries on over the pages: every line is on the page (above the footer), and page 1 isn't left empty
        const r = await cp.evaluate(async () => {
          window.__pdf.pos = [];
          await PVR.build({ siteName: 'Long', completed: Date.now(), breaches: Array.from({ length: 1500 }, (_, i) => `Station ${i + 1}`), entries: [] });
          return window.__pdf.pos;
        });
        // just the stations (no limits or counts), each one on a page above the footer
        const lines = r.filter(p => /^Station\s\d+/.test(p.t)), names = new Set(lines.flatMap(p => p.t.replace(/\u00a0/g, " ").split(/,\s+/).map(x => x.trim()).filter(Boolean)));
        if (names.size !== 1500 || lines.some(p => p.y > 198) || !lines.some(p => p.page === 1) || !r.some(p => p.page === 2 && /CRITICAL LIMIT BREACH .*\(continued\)/.test(p.t)) || r.some(p => /over\)|limit \d/.test(p.t)))
          all.push(`[${cp.app}] a long breach list doesn't carry onto the next page: ${names.size} stations, lowest ${Math.max(...lines.map(p => p.y))}, on pages ${Array.from(new Set(lines.map(p => p.page))).join(',')}`);
      }
    });
    await step(cp, 'days open', async () => {
      const d = await cp.evaluate(() => [calDays(new Date(2026, 0, 1, 23).getTime(), new Date(2026, 0, 2, 1).getTime()), calDays(new Date(2026, 0, 1, 1).getTime(), new Date(2026, 0, 1, 23).getTime())]);
      if (d.join() !== '1,0') all.push(`[${cp.app}] days open aren't calendar days: ${d}`);
    });
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
  await step(ad, 'expiry calendar', async () => {
    for (const day of [dayIn(200), dayIn(15)]) {
      await ad.evaluate(() => { openAdmin('documents'); adminDocExpiry('d1'); });
      await ad.waitForSelector('#pickDateInput', { timeout: 5000 });
      if (await ad.getAttribute('#pickDateInput', 'type') !== 'date') all.push('[admin] the expiry date is not a calendar');
      await ad.fill('#pickDateInput', day);
      if (day === dayIn(200)) await ad.screenshot({ path: path.join(SHOTS, 'admin-expiry-calendar.png') });
      await ad.evaluate(() => document.getElementById('pickDateInput').form.requestSubmit()); await sleep(1200);
      const v = await ad.evaluate(() => adminData.docs.find(d => d.id === 'd1').expires_on);
      if (String(v).slice(0, 10) !== day) all.push(`[admin] the expiry date picked wasn't saved: ${v} (wanted ${day})`);
    }
  });
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
    if (w === 1280) await step(sp, 'remove a station on the visit', async () => {
      await sp.evaluate(() => performDeleteStation('B10')); await sleep(800);
      const ch = await sp.evaluate(() => visitStationChanges('1'));
      if (!ch.removed.some(s => s.barcode === 'B10' && s.name === 'Station 10')) all.push(`[${sp.app}] a station removed on the visit isn't noted: ${JSON.stringify(ch)}`);
    });
    await step(sp, 'scan', () => sp.evaluate(() => handleScannedBarcode('B3')));
    await step(sp, 'save', () => sp.evaluate(() => { return saveStationServiceRecord(); }));
    await step(sp, 'complete', async () => { await sp.evaluate(() => { askChoice = async () => 'b'; return openCompleteVisitModal(); }); });
    await step(sp, 'sign tab', () => sp.evaluate(() => { document.getElementById('closingSiteNotes').value = 'ok'; setCloseTab('sign'); }));
    const review = await sp.evaluate(() => (document.getElementById('signOffReview').textContent || ''));
    if (!/Stations scanned \(1 of 1[12]\)/.test(review)) all.push(`[${sp.app}] the sign step doesn't count the saved station: ${review.slice(0, 200)}`);
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
