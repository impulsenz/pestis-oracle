// tools/test_site.mjs: adds a pretend site straight into the database of a running server, the apps read it like any
// other site (staff, and a client given access), and "remove" takes away exactly that site's data.
import path from 'node:path';
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

  let out = tool('add', '--client', 'cara@acme.test');
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
} catch (e) { fails++; console.log('ERROR', e); }
finally {
  srv.stop();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
