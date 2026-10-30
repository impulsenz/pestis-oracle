#!/usr/bin/env node
// A pretend site to try things out on, with stations, critical limits and about 18 months of made-up history
// (monthly visits, station checks, preparations, recommendations, a pest sighting). Nothing here is part of the
// apps: it only adds rows to the database, which the apps show like any other site - and removes them again.
//
// On the server (over SSH), as the pestis user so the database keeps the right owner:
//   sudo -u pestis node /opt/pestis/app/tools/test_site.mjs add                      add the test site (14 stations, 18 months)
//   sudo -u pestis node /opt/pestis/app/tools/test_site.mjs add-big                  a bigger one: 20 stations, 5 years
//   sudo -u pestis node /opt/pestis/app/tools/test_site.mjs add --client you@x.com   ...and let that client login see it
//   sudo -u pestis node /opt/pestis/app/tools/test_site.mjs status                   is there a test site?
//   sudo -u pestis node /opt/pestis/app/tools/test_site.mjs remove                   delete the test site and everything on it
// Options: --db <path to pestis.db> (default $DATA_DIR/pestis.db, i.e. /var/lib/pestis/pestis.db),
//          --stations <n> (2-20, default 14), --years <n> or --months <n> (up to 6 years; default 18 months)
//
// Everything it makes is marked: the site's Notes say TEST_MARK, and every row of its own carries the site's id, so
// "remove" deletes exactly the test site's data and nothing else. Run "add" again only after "remove".
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { STANDARD_FOLDERS, SITE_TABLES, TABLES } from '../server/schema.mjs';

const TEST_MARK = 'PESTIS TEST SITE - made by tools/test_site.mjs (remove it with: test_site.mjs remove)';
const SITE_NAME = 'TEST - Harbour Foods (pretend site)';
const TECH = 'Test Technician';

const args = process.argv.slice(2);
const big = args[0] === 'add-big';   // 20 stations, 5 years
const cmd = big ? 'add' : args[0];
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
const dbPath = opt('db') || path.join(process.env.DATA_DIR || '/var/lib/pestis', 'pestis.db');
const MONTHS = Math.max(2, Math.min(72, Number(opt('years')) * 12 || Number(opt('months')) || (big ? 60 : 18)));
const STATION_COUNT = Math.max(2, Math.min(20, Number(opt('stations')) || (big ? 20 : 14)));
if (!['add', 'remove', 'status'].includes(cmd)) {
  console.log('Use: test_site.mjs add | add-big | status | remove   (options: --client email, --stations n, --years n, --months n, --db path)');
  process.exit(1);
}
if (!fs.existsSync(dbPath)) { console.error(`No database at ${dbPath} (use --db to say where it is).`); process.exit(1); }

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000;');
const testSites = () => db.prepare('SELECT id, Name FROM clients WHERE Notes = ?').all(TEST_MARK);
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
// a row as the server would save it: every required column that has a default gets it (e.g. an empty photo list)
const insert = (table, input) => {
  const row = Object.assign({}, input);
  for (const [col, cd] of Object.entries((TABLES[table] || {}).cols || {})) {
    if (row[col] !== undefined || cd.def === undefined || cd.def === 'identity' || cd.def === 'uid') continue;
    row[col] = cd.def === 'now' ? new Date().toISOString() : cd.def === 'uuid' ? crypto.randomUUID() : (typeof cd.def === 'object' ? JSON.parse(JSON.stringify(cd.def)) : cd.def);
  }
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map(c => row[c] === undefined ? null : (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])));
};

if (cmd === 'status') {
  const s = testSites();
  if (!s.length) console.log('There is no test site.');
  for (const x of s) {
    const n = t => db.prepare(`SELECT count(*) AS n FROM "${t}" WHERE client_id = ?`).get(t === 'service_logs' ? Number(x.id) : String(x.id)).n;
    console.log(`Test site #${x.id} "${x.Name}": ${n('stations')} stations, ${n('service_logs')} station checks, ${n('visits')} visits, ${n('recommendations')} recommendations.`);
  }
  process.exit(0);
}

if (cmd === 'remove') {
  const s = testSites();
  if (!s.length) { console.log('There is no test site - nothing to remove.'); process.exit(0); }
  tx(() => {
    for (const x of s) {
      const id = String(x.id);
      // the rows that hang off a recommendation of this site first, then every site table, then the site
      const recIds = db.prepare('SELECT id FROM recommendations WHERE client_id = ?').all(id).map(r => r.id);
      for (const t of ['recommendation_updates', 'recommendation_views', 'recommendation_view_log']) {
        const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
        if (cols.includes('client_id')) db.prepare(`DELETE FROM "${t}" WHERE client_id = ?`).run(id);
        if (cols.includes('rec_id')) for (const r of recIds) db.prepare(`DELETE FROM "${t}" WHERE rec_id = ?`).run(r);
      }
      for (const t of SITE_TABLES) db.prepare(`DELETE FROM "${t}" WHERE client_id = ?`).run(t === 'service_logs' ? Number(id) : id);
      for (const t of ['site_events', 'site_contacts', 'client_access']) {
        const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
        if (cols.includes('client_id')) db.prepare(`DELETE FROM "${t}" WHERE client_id = ?`).run(id);
      }
      db.prepare('DELETE FROM clients WHERE id = ?').run(Number(id));
      console.log(`Removed test site #${id} "${x.Name}" and everything on it.`);
    }
  });
  process.exit(0);
}

// ---------- add ----------
if (testSites().length) { console.log('A test site is already there. Run "remove" first if you want a fresh one.'); process.exit(1); }
let seed = 20261030;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };   // the same history every time
const pick = list => list[Math.floor(rnd() * list.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const iso = d => d.toISOString();
const day = d => iso(d).slice(0, 10);
const uuid = () => crypto.randomUUID();
const now = new Date();
const monthStart = back => new Date(now.getFullYear(), now.getMonth() - back, 1);

// every station type (the first --stations of them are used; 20 = all of them)
const ALL_STATIONS = [
  // [barcode, name, type, limit]
  ['TEST-ILT-01', 'Dock ILT', 'Flying Insect Monitoring', 'Food hall'],
  ['TEST-ILT-02', 'Packing ILT', 'Flying Insect Monitoring', 'Food hall'],
  ['TEST-ILT-03', 'Bakery ILT', 'Flying Insect Monitoring', 'Food hall'],
  ['TEST-ILT-04', 'Goods-in ILT', 'Flying Insect Monitoring', 'Warehouse'],
  ['TEST-CR-01', 'Kitchen crawler', 'Crawling Insect Monitoring', 'Warehouse'],
  ['TEST-CR-02', 'Store room crawler', 'Crawling Insect Monitoring', 'Warehouse'],
  ['TEST-CR-03', 'Staff room crawler', 'Crawling Insect Monitoring', null],
  ['TEST-IT-01', 'Plant room bait', 'Internal Toxic Rodent Station', null],
  ['TEST-IT-02', 'Roof void bait', 'Internal Toxic Rodent Station', null],
  ['TEST-IN-01', 'Dry store trap', 'Internal Non-Toxic Rodent Station', null],
  ['TEST-EN-01', 'Bin area trap', 'External Non-Toxic Rodent Station', null],
  ['TEST-EN-02', 'Back fence trap', 'External Non-Toxic Rodent Station', null],
  ['TEST-ET-01', 'Car park bait', 'External Toxic Rodent Station', null],
  ['TEST-ET-02', 'Loading bay bait', 'External Toxic Rodent Station', null],
  ['TEST-ILT-05', 'Canteen ILT', 'Flying Insect Monitoring', 'Food hall'],
  ['TEST-CR-04', 'Cool store crawler', 'Crawling Insect Monitoring', 'Warehouse'],
  ['TEST-IN-02', 'Office trap', 'Internal Non-Toxic Rodent Station', null],
  ['TEST-ET-03', 'Side gate bait', 'External Toxic Rodent Station', null],
  ['TEST-PS-01', 'Reception sighting register', 'Pest Sighting Register', null],
  ['TEST-IP-01', 'Roof inspection point', 'Inspection Point', null],
];
const STATIONS = ALL_STATIONS.slice(0, STATION_COUNT);
const LIMITS = [
  { name: 'Food hall', rules: [{ species: 'Fly', max: 40 }, { species: 'Midges', max: 150 }, { species: 'Blowfly', max: 15 }] },
  { name: 'Warehouse', rules: [{ species: 'Fly', max: 60 }, { species: 'German Cockroach', max: 10 }] },
];
// how busy each month is (summer in New Zealand: more flies), 0-11 = Jan-Dec
const season = m => [1.6, 1.7, 1.4, 1.0, 0.6, 0.4, 0.3, 0.4, 0.6, 0.9, 1.2, 1.5][m];
const isFly = t => /flying/i.test(t), isCrawl = t => /crawling/i.test(t), isToxic = t => /toxic/i.test(t) && !/non-toxic/i.test(t), isLook = t => /sighting|inspection/i.test(t);

let site;
tx(() => {
  const r = insert('clients', {
    Name: SITE_NAME, Address: '1 Test Wharf, Gisborne', Contact: 'Pat Pretend 021 000 0000', Email: 'pat@example.invalid', Notes: TEST_MARK,
    services: [{ id: uuid(), type: 'Routine Service', frequency: 'monthly', lastDone: day(new Date(now.getFullYear(), now.getMonth(), Math.min(8, now.getDate()))), nextDue: day(new Date(now.getFullYear(), now.getMonth() + 1, 8)), notes: 'Test service' },
      { id: uuid(), type: 'Fogging', frequency: 'months:2,3,11', lastDone: '', nextDue: '', notes: 'Test: certain months each year' }],
    contract_start: day(monthStart(MONTHS)), contract_end: day(new Date(now.getFullYear() + 1, now.getMonth(), 1)), created_at: iso(monthStart(MONTHS)),
  });
  site = String(r.lastInsertRowid);
  for (const f of STANDARD_FOLDERS) insert('site_document_folders', { id: uuid(), client_id: site, name: f, created_by: 'Test data', created_at: iso(now) });
  const limitId = {};
  for (const l of LIMITS) { limitId[l.name] = uuid(); insert('site_limits', { id: limitId[l.name], client_id: site, name: l.name, rules: l.rules, created_by: 'Test data', created_at: iso(monthStart(MONTHS)), updated_at: iso(monthStart(MONTHS)) }); }
  for (const [barcode, name, type, lim] of STATIONS)
    insert('stations', { id: uuid(), client_id: site, barcode, name, type, limit_id: lim ? limitId[lim] : null, created_by: TECH, created_at: iso(monthStart(MONTHS)), updated_at: iso(monthStart(MONTHS)) });

  // one routine visit a month (this month's only if its day has come), every station checked
  let checks = 0, visits = 0;
  for (let back = MONTHS - 1; back >= 0; back--) {
    const visitDay = int(5, 20);
    const start = new Date(now.getFullYear(), now.getMonth() - back, visitDay, int(7, 10), int(0, 59));
    if (start > now) continue;
    const s = season(start.getMonth());
    let t = start.getTime();
    for (const [barcode, name, type] of STATIONS) {
      t += int(2, 6) * 60000;
      const p = { locationName: name, deviceType: type, technician: TECH, servicedAt: iso(new Date(t)), notes: '' };
      if (isFly(type)) {
        const fly = Math.round(int(5, 30) * s * (name === 'Dock ILT' ? 1.6 : 1)), midges = Math.round(int(10, 120) * s), blow = Math.round(int(0, 10) * s);
        Object.assign(p, { activityLevel: 'Caught', speciesCaught: 'Fly', pestCount: fly, morePests: [{ species: 'Midges', activity: 'Caught', count: midges }].concat(blow ? [{ species: 'Blowfly', activity: 'Caught', count: blow }] : []),
          prepUsed: 'Glue Board', quantity: 1, quantityUnit: 'each', batchNumber: 'GB-' + (2400 + back) });
      } else if (isCrawl(type)) {
        const n = Math.round(int(0, 9) * s);
        Object.assign(p, n ? { activityLevel: 'Caught', speciesCaught: 'German Cockroach', pestCount: n } : { activityLevel: 'None', speciesCaught: 'None' },
          n > 4 ? { prepUsed: 'Advion Cockroach Gel', quantity: int(2, 6), quantityUnit: 'g', batchNumber: 'AV-' + (88 + back) } : { prepUsed: 'None - Monitoring Only' });
      } else if (isLook(type)) {
        // a sighting register or inspection point: usually nothing; now and then something seen
        const seen = rnd() < 0.15;
        Object.assign(p, seen ? { activityLevel: 'Low', speciesCaught: pick(['Mice', 'German Cockroach', 'Ants', 'Fly']), notes: 'Seen by staff - checked and treated' } : { activityLevel: 'None', speciesCaught: 'None' }, { prepUsed: 'None - Monitoring Only' });
      } else if (isToxic(type)) {
        const lv = pick(['None', 'None', 'Low', 'Low', 'Medium', 'High']);
        Object.assign(p, { activityLevel: lv, speciesCaught: lv === 'None' ? 'None' : pick(['Rat', 'Mice']), prepUsed: pick(['Contrac', 'Generation']), quantity: int(1, 4), quantityUnit: 'each', batchNumber: 'RB-' + (310 + back) });
      } else {
        const n = rnd() < 0.3 ? int(1, 2) : 0;
        Object.assign(p, n ? { activityLevel: 'Caught', speciesCaught: pick(['Rat', 'Mice']), pestCount: n } : { activityLevel: 'None', speciesCaught: 'None' }, { prepUsed: 'None - Monitoring Only' });
      }
      insert('service_logs', { client_id: Number(site), barcode_id: barcode, payload: p, created_at: p.servicedAt });
      checks++;
    }
    const end = new Date(t + 10 * 60000);
    insert('visits', { id: uuid(), client_id: site, visit_type: 'Routine Service', technician: TECH, started_at: iso(start), signed_in_at: iso(start), completed_at: iso(end), signed_out_at: iso(end),
      notes: 'Test visit: all stations checked.', services_completed: ['Routine Service'], unscanned_count: 0, signed_by: 'Pat Pretend', signed_at: iso(end), created_at: iso(end) });
    visits++;
  }

  // a few recommendations (some done, some still open) and a pest sighting from the client
  const recs = [
    [MONTHS - 3, 'TEST-ILT-01', 'Dock ILT', 'Keep the dock door closed when not loading - flies are coming in from the yard.', 'complete'],
    [6, 'TEST-CR-01', 'Kitchen crawler', 'Seal the gap behind the dishwasher where cockroaches are harbouring.', 'complete'],
    [2, 'TEST-ET-02', 'Loading bay bait', 'Clear the pallets stacked against the wall - they give rats cover.', 'pending'],
    [0, 'TEST-ILT-02', 'Packing ILT', 'Replace the UV tubes in the packing room ILT (due for their yearly change).', 'open'],
  ];
  for (const [back, bc, name, text, status] of recs) {
    const at = new Date(now.getFullYear(), now.getMonth() - Math.min(back, MONTHS - 1), 12, 11, 0);
    if (at > now) at.setTime(now.getTime() - 3600000);
    // the next recommendation number, from the same counter the server uses (so real ones never clash)
    const key = 'seq:recommendations.rec_no';
    const top = db.prepare('SELECT MAX(rec_no) AS m FROM recommendations').get().m || 0, meta = db.prepare('SELECT value FROM server_meta WHERE key = ?').get(key);
    const recNo = Math.max(Number(meta ? meta.value : 0), top) + 1;
    db.prepare('INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(recNo));
    insert('recommendations', { id: uuid(), rec_no: recNo, client_id: site, station_barcode: bc, station_name: name, station_type: (STATIONS.find(x => x[0] === bc) || [])[2], text, status,
      raised_at: iso(at), raised_by: TECH, completed_at: status === 'complete' ? iso(new Date(at.getTime() + 20 * 86400000)) : null, created_at: iso(at) });
  }
  const seen = new Date(now.getTime() - 3 * 86400000);
  insert('pest_sightings', { id: uuid(), client_id: site, sighting_no: 1, pest: 'Mice', location: 'Dry store, behind the flour sacks', seen_at: iso(seen), number_seen: 2, evidence: 'Droppings',
    urgency: 'Routine', reported_by: 'Pat Pretend', details: 'Test sighting.', status: 'new', created_by: 'Test data', created_at: iso(seen) });

  // let a client login see it (it must already be a client login, made in Admin)
  const email = (opt('client') || '').trim().toLowerCase();
  if (email) {
    if (db.prepare('SELECT 1 FROM client_users WHERE email = ?').get(email)) insert('client_access', { email, client_id: site, added_by: 'Test data', added_at: iso(now) });
    else console.log(`(${email} isn't a client login yet - add it in Admin, then tick the test site for it.)`);
  }
  console.log(`Added test site #${site} "${SITE_NAME}": ${STATIONS.length} stations, ${visits} visits, ${checks} station checks over ${MONTHS} months, ${recs.length} recommendations, 1 pest sighting.`);
});
