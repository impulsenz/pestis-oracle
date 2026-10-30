// tools/test_site.mjs: adds a pretend site straight into the database of a running server, the apps read it like any
// other site (staff, and a client given access), and "remove" takes away exactly that site's data.
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { start, idToken, tmpDir } from './harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8097, BASE = `http://127.0.0.1:${PORT}`, DIR = tmpDir('testsite'), DB = path.join(DIR, 'pestis.db');
const srv = await start({ port: PORT, dataDir: DIR });
let fails = 0, passes = 0;
const ok = (c, m, x) => { if (c) { passes++; console.log('PASS', m); } else { fails++; console.log('FAIL', m, x !== undefined ? JSON.stringify(x).slice(0, 500) : ''); } };
const session = async email => (await (await fetch(BASE + '/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: idToken(email) }) })).json()).session;
const api = s => async (table, body) => (await fetch(BASE + '/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.access_token }, body: JSON.stringify(Object.assign({ table }, body)) })).json();
const tool = (...a) => execFileSync(process.execPath, [path.join(ROOT, 'tools', 'test_site.mjs'), ...a, '--db', DB], { encoding: 'utf8' });

try {
  const boss = await session('boss@example.com');
  // a real site, which must be left alone
  await api(boss)('clients', { op: 'insert', values: [{ Name: 'Real Site', Address: '9 Real St' }] });
  await api(boss)('stations', { op: 'insert', values: [{ id: 'real-1', client_id: '1', barcode: 'R1', name: 'Real station' }] });
  await api(boss)('recommendations', { op: 'insert', values: [{ id: 'real-rec', client_id: '1', text: 'A real recommendation' }] });
  await api(boss)('client_users', { op: 'insert', values: { email: 'cara@acme.test', full_name: 'Cara Client', company: 'Acme' } });

  let out = tool('add', '--client', 'cara@acme.test'), r;
  ok(/Added test site #2/.test(out), 'add: the test site is made', out);
  try { out = tool('add'); } catch (e) { out = String(e.stdout || ''); }
  ok(/already there/.test(out), 'add twice is refused', out);
  const sites = (await api(boss)('clients', {})).data || [];
  const t = sites.find(x => /^TEST - /.test(x.Name));
  ok(t && sites.length === 2, 'staff see the test site next to the real one', sites.map(x => x.Name));
  const logs = (await api(boss)('service_logs', { filters: [['client_id', 'eq', t.id]] })).data || [];
  ok(logs.length > 100 && logs.every(l => l.payload && l.payload.servicedAt && l.payload.locationName), 'it has a history of station checks the apps can read', logs.length);
  const recs = (await api(boss)('recommendations', { filters: [['client_id', 'eq', String(t.id)]] })).data || [];
  const realRec = ((await api(boss)('recommendations', { filters: [['id', 'eq', 'real-rec']] })).data || [])[0];
  ok(recs.length === 4 && recs.every(r => r.rec_no > realRec.rec_no) && new Set(recs.map(r => r.rec_no)).size === 4, 'its recommendations get their own numbers after the real ones', recs.map(r => r.rec_no));
  await api(boss)('recommendations', { op: 'insert', values: [{ id: 'real-rec-2', client_id: '1', text: 'Another real one' }] });
  const r2 = ((await api(boss)('recommendations', { filters: [['id', 'eq', 'real-rec-2']] })).data || [])[0];
  ok(r2 && r2.rec_no > Math.max(...recs.map(r => r.rec_no)), 'a real recommendation made afterwards still gets the next number', r2 && r2.rec_no);
  const cara = await session('cara@acme.test');
  const portal = await (await fetch(BASE + '/api/rpc/portal_sites', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cara.access_token }, body: '{}' })).json();
  ok(Array.isArray(portal.data) && portal.data.length === 1 && portal.data[0].Name === t.Name, 'the client login given access sees the test site (and only it)', portal);
  ok(/stations, \d+ station checks/.test(tool('status')), 'status describes the test site');
  // its pest sighting can be actioned (it was saved with an empty photo list, as the app would)
  const tech = await session('boss@example.com');
  const sight = ((await api(tech)('pest_sightings', { filters: [['client_id', 'eq', String(t.id)]] })).data || [])[0];
  r = await api(tech)('pest_sightings', { op: 'update', filters: [['id', 'eq', sight.id]], values: { status: 'actioned', action_notes: 'Checked', actioned_by: 'Bob' }, returning: true });
  ok(!r.error && r.data && r.data[0].status === 'actioned' && Array.isArray(r.data[0].photos), "the test site's pest sighting can be actioned", r);
  // a record saved without its photo list (as an older version of this script did) is repaired when it's changed
  {
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(DB); raw.exec('PRAGMA busy_timeout = 5000;');
    raw.prepare('UPDATE pest_sightings SET photos = NULL, action_photos = NULL WHERE id = ?').run(sight.id);
    raw.close();
    r = await api(tech)('pest_sightings', { op: 'update', filters: [['id', 'eq', sight.id]], values: { action_notes: 'Checked again' }, returning: true });
    ok(!r.error && r.data && JSON.stringify(r.data[0].photos) === '[]' && JSON.stringify(r.data[0].action_photos) === '[]', 'a record missing its photo list is repaired instead of refused', r);
  }

  out = tool('remove');
  ok(/Removed test site/.test(out), 'remove: the test site is deleted', out);
  const after = (await api(boss)('clients', {})).data || [];
  const left = async tn => ((await api(boss)(tn, { filters: [['client_id', 'eq', tn === 'service_logs' ? t.id : String(t.id)]] })).data || []).length;
  ok(after.length === 1 && after[0].Name === 'Real Site', 'only the real site is left', after.map(x => x.Name));
  ok(!(await left('service_logs')) && !(await left('stations')) && !(await left('visits')) && !(await left('recommendations')) && !(await left('site_limits')), 'none of the test site\'s data is left');
  ok(((await api(boss)('stations', {})).data || []).length === 1 && ((await api(boss)('recommendations', {})).data || []).length === 2, 'the real site\'s stations and recommendations are untouched');
  ok(/no test site/i.test(tool('status')), 'status: no test site');

  // the bigger one: 20 stations of every type, 5 years of history - and remove takes it all away again
  out = tool('add-big');
  const m = /#(\d+).*: 20 stations, (\d+) visits, (\d+) station checks over 60 months/.exec(out);
  ok(m && Number(m[2]) >= 59 && Number(m[3]) >= 59 * 20, 'add-big: 20 stations and 5 years of visits and checks', out);
  const bid = m && m[1];
  const bst = ((await api(boss)('stations', { filters: [['client_id', 'eq', String(bid)]] })).data || []);
  const types = new Set(bst.map(x => x.type));
  ok(bst.length === 20 && ['Flying Insect Monitoring', 'Crawling Insect Monitoring', 'Internal Toxic Rodent Station', 'External Toxic Rodent Station', 'Internal Non-Toxic Rodent Station', 'External Non-Toxic Rodent Station', 'Pest Sighting Register', 'Inspection Point'].every(ty => types.has(ty)), 'add-big: stations of every type', [...types]);
  const oldest = ((await api(boss)('service_logs', { filters: [['client_id', 'eq', Number(bid)]], order: [['created_at', true]], limit: 1 })).data || [])[0];
  ok(oldest && Date.now() - Date.parse(oldest.payload.servicedAt) > 4.8 * 365 * 86400000, 'add-big: the history goes back about 5 years', oldest && oldest.payload.servicedAt);
  out = tool('remove');
  ok(/Removed test site/.test(out) && !(await left('service_logs')) && ((await api(boss)('clients', {})).data || []).length === 1, 'remove: the big test site is gone too, the real site stays', out);

  // the huge pretend site (tools/huge_site.mjs), made small here: every part of it, and remove takes it all away (pictures too)
  {
    const huge = (...a) => execFileSync(process.execPath, [path.join(ROOT, 'tools', 'huge_site.mjs'), ...a, '--db', DB], { encoding: 'utf8' });
    out = huge('add', '--stations', '240', '--years', '3', '--client', 'cara@acme.test');
    const hm = /#(\d+) .*: (\d+) stations .* of (\d+) types, 6 buildings, 8 floor plans with every station pinned, (\d+) visits over 3 years \(([^)]*)\), ([\d,]+) station checks, 100 recommendations/.exec(out);
    ok(hm, 'huge site: made', out);
    const hid = hm && hm[1];
    const rows = async (t, f) => ((await api(boss)(t, { filters: [['client_id', 'eq', t === 'service_logs' ? Number(hid) : String(hid)]].concat(f || []) })).data || []);
    const st = await rows('stations'), maps = await rows('site_maps'), bld = await rows('site_buildings'), vis = await rows('visits');
    ok(st.length > 200 && st.every(x => x.map_id && x.pin_x != null && maps.some(m => m.id === x.map_id)) && new Set(st.map(x => x.type)).size >= 8, 'huge site: stations of every type, each pinned on a floor plan', { n: st.length, types: new Set(st.map(x => x.type)).size });
    ok(bld.length === 6 && maps.length === 8 && maps.every(m => bld.some(b => b.id === m.building_id) && m.image_path), 'huge site: 6 buildings, 8 floor plans under them, each with a picture', { b: bld.length, m: maps.length });
    vis.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
    const kinds = new Set(vis.map(v => v.visit_type));
    ok(vis[0].visit_type === 'Initial Install' && ['Routine Service', 'Meeting', 'Call Out', 'Broken Treatment', 'Technical Support', 'Uninstall'].every(k => kinds.has(k)) || (vis[0].visit_type === 'Initial Install' && kinds.has('Meeting') && kinds.has('Routine Service')),
      'huge site: the first visit is the initial install, then routine services, meetings, call outs and more', [vis[0].visit_type, ...kinds]);
    const perMonth = new Map(); vis.forEach(v => { const k = String(v.started_at).slice(0, 7); perMonth.set(k, (perMonth.get(k) || 0) + 1); });
    ok(Math.max(...perMonth.values()) >= 2 && Math.max(...perMonth.values()) <= 6, 'huge site: mostly one visit a month, up to five', [...perMonth.values()]);
    const logs = await rows('service_logs');
    ok(logs.length > 240 * 20 && logs.filter(l => l.payload.prepUsed && l.payload.prepUsed !== 'None - Monitoring Only').length > logs.length / 2, 'huge site: station checks for every month, most with a preparation', logs.length);
    const [recs, sights, contacts, docs, lims] = await Promise.all(['recommendations', 'pest_sightings', 'site_contacts', 'site_documents', 'site_limits'].map(t => rows(t)));
    ok(recs.length === 100 && sights.length === 300 && contacts.length === 15 && new Set(contacts.map(c => c.role)).size === 15 && docs.length === 21 && lims.length === 4, 'huge site: 100 recommendations, 300 sightings, 15 contacts (15 roles), 21 documents, 4 critical limits',
      [recs.length, sights.length, contacts.length, docs.length, lims.length]);
    const cara2 = await session('cara@acme.test');
    const sees = await (await fetch(BASE + '/api/rpc/portal_sites', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cara2.access_token }, body: '{}' })).json();
    ok((sees.data || []).some(s => String(s.id) === String(hid)), 'huge site: the client login given access sees it');
    // a floor plan picture is served like any upload
    const sign = await (await fetch(BASE + '/api/files/sign', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + boss.access_token }, body: JSON.stringify({ bucket: 'station-photos', paths: [maps[0].image_path], expiresIn: 60 }) })).json().catch(() => null);
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(DB), files = raw.prepare("SELECT count(*) AS n FROM storage_objects WHERE name LIKE ? OR name LIKE ?").get(`${hid}/HUGE_%`, `site-covers/${hid}/HUGE_%`).n; raw.close();
    ok(files > 40 && fs.existsSync(path.join(DIR, 'files', 'station-photos', ...maps[0].image_path.split('/'))), 'huge site: its pictures and documents are stored like uploads', { files, sign });
    out = huge('remove');
    ok(/Removed huge test site/.test(out) && !(await rows('stations')).length && !(await rows('service_logs')).length && !(await rows('site_buildings')).length, 'huge site: remove deletes it all', out);
    const raw2 = new DatabaseSync(DB), left = raw2.prepare("SELECT count(*) AS n FROM storage_objects WHERE name LIKE ?").get(`${hid}/HUGE_%`).n; raw2.close();
    ok(left === 0 && !fs.existsSync(path.join(DIR, 'files', 'station-photos', ...maps[0].image_path.split('/'))) && ((await api(boss)('clients', {})).data || []).some(c => c.Name === 'Real Site'), 'huge site: its pictures are gone too, the real site stays', left);
  }
} catch (e) { fails++; console.log('ERROR', e); }
finally {
  srv.stop();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
