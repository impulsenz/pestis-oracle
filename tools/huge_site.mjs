#!/usr/bin/env node
// A HUGE pretend site to push the apps to their limits: about 3,000 stations of every station type in 6 buildings and
// 8 floor plans (drawn, with every station pinned), 10 years of history (one routine visit most months, up to 5 visits
// in a busy month: call outs, broken treatments, technical support, meetings, fogging), preparations on every check,
// 100 recommendations (with notes, photos and the client's replies), 300 pest sightings, 15 site contacts, 8 services,
// critical limits (with breaches), documents (some expired, some due), station photos, a cover picture and an activity log.
// Nothing here is part of the apps: it only adds rows (and pictures) to the server, which the apps show like any other site.
//
// On the server (over SSH), as the pestis user so the files keep the right owner:
//   sudo -u pestis node /opt/pestis/app/tools/huge_site.mjs add                       make the huge site (takes a minute or two)
//   sudo -u pestis node /opt/pestis/app/tools/huge_site.mjs add --client you@x.com    ...and let that client login see it
//   sudo -u pestis node /opt/pestis/app/tools/huge_site.mjs status                    is it there, and how big?
//   sudo -u pestis node /opt/pestis/app/tools/huge_site.mjs remove                    delete it and everything on it (and its pictures)
// Options: --stations <n> (60-5000, default 3000), --years <n> (1-15, default 10), --db <path to pestis.db>
//          (default $DATA_DIR/pestis.db, i.e. /var/lib/pestis/pestis.db; its pictures go in the files folder beside it)
//
// Everything it makes is marked: the site's Notes say HUGE_MARK, every row carries the site's id and every picture's name
// starts with HUGE_, so "remove" deletes exactly this site and nothing else. The smaller test_site.mjs site can sit beside it.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import path from 'node:path';
import fs from 'node:fs';
import { STANDARD_FOLDERS, SITE_TABLES, TABLES, PREPARATIONS } from '../server/schema.mjs';

const HUGE_MARK = 'PESTIS HUGE TEST SITE - made by tools/huge_site.mjs (remove it with: huge_site.mjs remove)';
const SITE_NAME = 'TEST - Kauri Coast Foods (huge pretend site)';
const PHOTO_BUCKET = 'station-photos', DOC_BUCKET = 'site-documents';

const args = process.argv.slice(2);
const cmd = args[0];
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : null; };
const dbPath = opt('db') || path.join(process.env.DATA_DIR || '/var/lib/pestis', 'pestis.db');
const filesDir = path.join(path.dirname(dbPath), 'files');
const TARGET = Math.max(60, Math.min(5000, Number(opt('stations')) || 3000));
const YEARS = Math.max(1, Math.min(15, Number(opt('years')) || 10));
const MONTHS = YEARS * 12;
if (!['add', 'remove', 'status'].includes(cmd)) {
  console.log('Use: huge_site.mjs add | status | remove   (options: --client email, --stations n, --years n, --db path)');
  process.exit(1);
}
if (!fs.existsSync(dbPath)) { console.error(`No database at ${dbPath} (use --db to say where it is).`); process.exit(1); }

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 5000;');
const hugeSites = () => db.prepare('SELECT id, Name FROM clients WHERE Notes = ?').all(HUGE_MARK);
const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
const tableCols = new Map();
const hasTable = t => { if (!tableCols.has(t)) tableCols.set(t, new Set(db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name))); return tableCols.get(t).size > 0; };
// a row as the server would save it: every required column that has a default gets it (e.g. an empty photo list);
// one prepared statement per shape, so hundreds of thousands of rows go in quickly
const stmts = new Map();
const insert = (table, input) => {
  const row = Object.assign({}, input);
  for (const [col, cd] of Object.entries((TABLES[table] || {}).cols || {})) {
    if (row[col] !== undefined || cd.def === undefined || cd.def === 'identity' || cd.def === 'uid') continue;
    row[col] = cd.def === 'now' ? new Date().toISOString() : cd.def === 'uuid' ? crypto.randomUUID() : (typeof cd.def === 'object' ? JSON.parse(JSON.stringify(cd.def)) : cd.def);
  }
  const cols = Object.keys(row), key = table + '|' + cols.join(',');
  if (!stmts.has(key)) stmts.set(key, db.prepare(`INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`));
  return stmts.get(key).run(...cols.map(c => row[c] === undefined ? null : row[c] === true ? 1 : row[c] === false ? 0 : (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])));
};
const count = (t, id) => hasTable(t) ? db.prepare(`SELECT count(*) AS n FROM "${t}" WHERE client_id = ?`).get(t === 'service_logs' ? Number(id) : String(id)).n : 0;

if (cmd === 'status') {
  const s = hugeSites();
  if (!s.length) console.log('There is no huge test site.');
  for (const x of s) console.log(`Huge test site #${x.id} "${x.Name}": ${count('stations', x.id)} stations, ${count('service_logs', x.id)} station checks, ${count('visits', x.id)} visits, `
    + `${count('recommendations', x.id)} recommendations, ${count('pest_sightings', x.id)} pest sightings, ${count('site_buildings', x.id)} buildings, ${count('site_maps', x.id)} floor plans.`);
  process.exit(0);
}

// pictures and documents go where the server keeps files, with a storage_objects row each (as an upload would make)
const putFile = (bucket, name, buf, mime) => {
  const p = path.join(filesDir, bucket, ...name.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO storage_objects (bucket, name, mime, size, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (bucket, name) DO UPDATE SET mime = excluded.mime, size = excluded.size, updated_at = excluded.updated_at`).run(bucket, name, mime, buf.length, null, now, now);
  return name;
};
const removeFiles = id => {
  const rows = db.prepare(`SELECT bucket, name FROM storage_objects WHERE name LIKE ? OR name LIKE ?`).all(`${id}/HUGE_%`, `site-covers/${id}/HUGE_%`);
  for (const r of rows) { try { fs.unlinkSync(path.join(filesDir, r.bucket, ...r.name.split('/'))); } catch (e) {} }
  db.prepare(`DELETE FROM storage_objects WHERE name LIKE ? OR name LIKE ?`).run(`${id}/HUGE_%`, `site-covers/${id}/HUGE_%`);
  return rows.length;
};

if (cmd === 'remove') {
  const s = hugeSites();
  if (!s.length) { console.log('There is no huge test site - nothing to remove.'); process.exit(0); }
  for (const x of s) {
    const id = String(x.id);
    let files = 0;
    tx(() => {
      const recIds = db.prepare('SELECT id FROM recommendations WHERE client_id = ?').all(id).map(r => r.id);
      for (const t of ['recommendation_updates', 'recommendation_views', 'recommendation_view_log']) {
        if (!hasTable(t)) continue;
        const cols = tableCols.get(t);
        if (cols.has('client_id')) db.prepare(`DELETE FROM "${t}" WHERE client_id = ?`).run(id);
        if (cols.has('rec_id')) { const del = db.prepare(`DELETE FROM "${t}" WHERE rec_id = ?`); for (const r of recIds) del.run(r); }
      }
      for (const t of SITE_TABLES) if (hasTable(t)) db.prepare(`DELETE FROM "${t}" WHERE client_id = ?`).run(t === 'service_logs' ? Number(id) : id);
      for (const t of ['site_events', 'site_contacts', 'client_access']) if (hasTable(t) && tableCols.get(t).has('client_id')) db.prepare(`DELETE FROM "${t}" WHERE client_id = ?`).run(id);
      db.prepare('DELETE FROM clients WHERE id = ?').run(Number(id));
      files = removeFiles(id);
    });
    console.log(`Removed huge test site #${id} "${x.Name}", everything on it and its ${files} pictures and documents.`);
  }
  // give the space back (the database file doesn't shrink by itself); fine to skip if the server is busy
  try { const before = fs.statSync(dbPath).size; db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.exec('VACUUM'); console.log(`Database shrunk from ${Math.round(before / 1048576)} MB to ${Math.round(fs.statSync(dbPath).size / 1048576)} MB.`); }
  catch (e) { console.log('(The database file will shrink later - the server was busy: ' + e.message + ')'); }
  process.exit(0);
}

// =====================================================================================
//  add
// =====================================================================================
if (hugeSites().length) { console.log('The huge test site is already there. Run "remove" first if you want a fresh one.'); process.exit(1); }
if (!hasTable('site_buildings')) { console.error('This server has no buildings table yet - let the server update and restart first (it does that by itself within 2 minutes of an update).'); process.exit(1); }
const started = Date.now();
let seed = 20261101;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };   // the same site every time
const pick = list => list[Math.floor(rnd() * list.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const chance = p => rnd() < p;
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const iso = d => new Date(d).toISOString();
const day = d => iso(d).slice(0, 10);
const uuid = () => crypto.randomUUID();
const now = new Date();
const monthStart = back => new Date(now.getFullYear(), now.getMonth() - back, 1);
const DAY = 86400000;

// ---------- pictures (PNG, made here: no libraries) ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
function canvas(w, h, bg) {
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) { px[i * 3] = bg[0]; px[i * 3 + 1] = bg[1]; px[i * 3 + 2] = bg[2]; }
  const rect = (x, y, rw, rh, c) => {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y)), x1 = Math.min(w, Math.round(x + rw)), y1 = Math.min(h, Math.round(y + rh));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * w + xx) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; }
  };
  const frame = (x, y, rw, rh, t, c) => { rect(x, y, rw, t, c); rect(x, y + rh - t, rw, t, c); rect(x, y, t, rh, c); rect(x + rw - t, y, t, rh, c); };
  const disc = (cx, cy, r, c) => { for (let yy = Math.max(0, Math.floor(cy - r)); yy < Math.min(h, cy + r); yy++) for (let xx = Math.max(0, Math.floor(cx - r)); xx < Math.min(w, cx + r); xx++) if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) { const i = (yy * w + xx) * 3; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; } };
  const png = () => {
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
  };
  return { rect, frame, disc, png, w, h };
}
const WALL = [51, 65, 85], ROOMS = [[239, 246, 255], [240, 253, 244], [254, 252, 232], [253, 242, 248], [245, 243, 255], [236, 254, 255], [255, 247, 237]];
// a building's floor: rooms in a grid with corridors between (their insides are where the stations go)
function floorPlan(cols, rows) {
  const W = 2000, H = 1300, M = 70, c = canvas(W, H, [255, 255, 255]);
  c.rect(M, M, W - 2 * M, H - 2 * M, [248, 250, 252]);
  const rooms = [], cw = (W - 2 * M) / cols, rh = (H - 2 * M) / rows;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (chance(0.12) && rooms.length) continue;   // an open area here and there
    const rx = M + x * cw + 18, ry = M + y * rh + 18, rw = cw - 36, rhh = rh - 36;
    c.rect(rx, ry, rw, rhh, pick(ROOMS)); c.frame(rx, ry, rw, rhh, 6, WALL);
    c.rect(rx + rw / 2 - 30, ry + rhh - 6, 60, 6, [248, 250, 252]);   // a door
    rooms.push({ x: rx + 24, y: ry + 24, w: rw - 48, h: rhh - 48 });
  }
  c.frame(M, M, W - 2 * M, H - 2 * M, 12, WALL);
  return { png: c.png(), w: W, h: H, spot: () => { const r = pick(rooms); return { x: (r.x + rnd() * r.w) / W, y: (r.y + rnd() * r.h) / H }; } };
}
// the grounds: the fence line, the buildings as blocks, a car park; stations along the fence and round the buildings
function grounds() {
  const W = 2400, H = 1500, M = 60, c = canvas(W, H, [255, 255, 255]);
  c.rect(M, M, W - 2 * M, H - 2 * M, [236, 253, 245]);
  const blocks = [[260, 220, 620, 420], [980, 220, 520, 360], [1620, 220, 520, 300], [260, 820, 460, 380], [1700, 760, 440, 440]];
  for (const [x, y, bw, bh] of blocks) { c.rect(x, y, bw, bh, [226, 232, 240]); c.frame(x, y, bw, bh, 10, WALL); }
  c.rect(860, 820, 720, 400, [229, 231, 235]); for (let i = 0; i < 9; i++) c.rect(880 + i * 78, 840, 6, 140, [255, 255, 255]);   // car park
  c.frame(M, M, W - 2 * M, H - 2 * M, 8, [21, 128, 61]);   // the fence
  const spot = () => {
    if (chance(0.45)) { const side = int(0, 3), t = rnd(); const x = side === 0 ? M + 30 + t * (W - 2 * M - 60) : side === 1 ? W - M - 30 : side === 2 ? M + 30 + t * (W - 2 * M - 60) : M + 30, y = side === 0 ? M + 30 : side === 1 ? M + 30 + t * (H - 2 * M - 60) : side === 2 ? H - M - 30 : M + 30 + t * (H - 2 * M - 60); return { x: x / W, y: y / H }; }
    const [x, y, bw, bh] = pick(blocks), side = int(0, 3), t = rnd();
    const px = side === 0 ? x + t * bw : side === 1 ? x + bw + 26 : side === 2 ? x + t * bw : x - 26, py = side === 0 ? y - 26 : side === 1 ? y + t * bh : side === 2 ? y + bh + 26 : y + t * bh;
    return { x: px / W, y: py / H };
  };
  return { png: c.png(), w: W, h: H, spot };
}
// a "photo": a few soft blocks of colour (a recommendation, sighting or station photo)
function photo(i) {
  const c = canvas(480, 320, [30 + (i * 37) % 120, 40 + (i * 53) % 110, 50 + (i * 71) % 100]);
  for (let k = 0; k < 6; k++) c.rect(int(0, 420), int(0, 260), int(60, 260), int(40, 200), [int(60, 230), int(60, 230), int(60, 230)]);
  c.disc(int(120, 360), int(90, 230), int(25, 60), [int(150, 255), int(120, 220), int(40, 120)]);
  return c.png();
}
// a one-page PDF with a title (a document in a folder)
function pdf(title, lines) {
  const esc = s => String(s).replace(/[()\\]/g, m => '\\' + m);
  const text = `BT /F1 20 Tf 60 770 Td (${esc(title)}) Tj ET\n` + lines.map((l, i) => `BT /F1 11 Tf 60 ${730 - i * 18} Td (${esc(l)}) Tj ET`).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out);
}

// ---------- the people ----------
const TECHS = ['Aroha Ngata', 'Ben Walker', 'Chloe Tan', 'Dev Patel', 'Ella Morrison', 'Finn O\'Connor'];
const CONTACTS = [
  ['Grace Whitfield', 'Site Manager', true], ['Hemi Parata', 'Operations Manager'], ['Isla Brown', 'Quality Assurance Manager'], ['Jack Liu', 'Food Safety Officer'],
  ['Kate Robinson', 'Health & Safety Officer'], ['Liam Ferreira', 'Facilities Manager'], ['Mere Tipene', 'Maintenance Supervisor'], ['Noah Singh', 'Warehouse Manager'],
  ['Olivia Grant', 'Production Manager'], ['Pita Henare', 'Cleaning Supervisor'], ['Quinn Adams', 'Canteen Manager'], ['Rosa Martinez', 'Security Lead'],
  ['Sam Kowalski', 'Accounts Payable'], ['Tui Wihongi', 'Procurement Officer'], ['Uma Reddy', 'Night Shift Supervisor'],
];
const SIGNERS = CONTACTS.slice(0, 11).map(c => c[0]);

// ---------- what's on the site ----------
const speciesHere = new Set(hasTable('species') ? db.prepare('SELECT label FROM species').all().map(r => r.label) : []);
const sp = (name, fallback) => speciesHere.size && !speciesHere.has(name) ? (fallback || name) : name;
const FLYING = ['Fly', 'Midges', 'Blowfly', 'Moths', 'Wasps', 'Mosquitoes'].map(x => sp(x, 'Fly'));
const CRAWLING = ['German Cockroach', 'American Cockroach', 'Ants', 'Silverfish', 'Spiders', 'Beetles'].map(x => sp(x, 'German Cockroach'));
const RODENTS = ['Rat', 'Mice'].map(x => sp(x));
const UNIT = Object.fromEntries((PREPARATIONS || []).map(([l, u]) => [l, u]));
const prep = (name, qty, yr, q) => ({ prepUsed: name, quantity: qty, quantityUnit: UNIT[name] || 'each', batchNumber: `${name.replace(/[^A-Z]/g, '').slice(0, 3) || 'BT'}-${yr}${String(q).padStart(2, '0')}-${int(10, 99)}` });

const CORE = [
  ['Flying Insect Monitoring', 'ILT', 300], ['Crawling Insect Monitoring', 'Crawl', 520], ['Internal Toxic Rodent Station', 'Bait', 330], ['Internal Non-Toxic Rodent Station', 'Trap', 650],
  ['External Toxic Rodent Station', 'Ext bait', 420], ['External Non-Toxic Rodent Station', 'Ext trap', 380], ['Pest Sighting Register', 'Register', 60], ['Inspection Point', 'Inspect', 120],
];
// any other station type in the Admin list gets some too, so every type is tried
const listed = hasTable('station_types') ? db.prepare('SELECT label FROM station_types').all().map(r => r.label).filter(Boolean) : [];
const extra = listed.filter(t => !CORE.some(c => c[0].toLowerCase() === t.toLowerCase())).map(t => [t, t.split(/\s+/).slice(0, 2).join(' '), 40]);
const TYPES = CORE.concat(extra);
const scale = TARGET / TYPES.reduce((n, t) => n + t[2], 0);
const isExt = t => /external|outdoor|perimeter/i.test(t), isFly = t => /flying/i.test(t), isCrawl = t => /crawling/i.test(t);
const isToxic = t => /toxic|bait/i.test(t) && !/non-toxic/i.test(t), isLook = t => /sighting|inspection/i.test(t), isRodentT = t => /rodent|rat|mouse|mice|bait/i.test(t);

const BUILDINGS = [
  { name: 'Building A - Production', plans: [['Ground floor', 5, 3, 0, 0.27], ['Mezzanine', 4, 2, 0, 0.09]] },
  { name: 'Building B - Warehouse', plans: [['Racking and dry store', 6, 3, 0, 0.19]] },
  { name: 'Building C - Offices and canteen', plans: [['Ground floor', 4, 3, 36, 0.10], ['Level 1', 4, 2, 36, 0.07]] },
  { name: 'Building D - Cold store', plans: [['Cold store', 3, 2, 36, 0.09]] },
  { name: 'Building E - Dispatch', plans: [['Dispatch and loading', 5, 2, 72, 0.19]] },
  { name: 'Site grounds', plans: [['Perimeter and yard', 0, 0, 0, 1, true]] },
];
// [name, room columns, room rows, months after the start it was built, share of the inside stations, outside?]

let site, summary;
const t0 = MONTHS;   // months ago the site started (the initial install)
tx(() => {
  // ---------- the site ----------
  const services = [
    { type: 'Routine Service', frequency: 'monthly', notes: 'All stations checked every month' },
    { type: 'ILT tube change', frequency: 'annually', notes: 'Every insect light trap gets new tubes in September' },
    { type: 'Fogging', frequency: 'months:1,2,12', notes: 'Summer fogging of the production hall' },
    { type: 'Bird control check', frequency: 'quarterly', notes: 'Spikes and netting on the dispatch canopy' },
    { type: 'Stored product monitoring', frequency: 'bimonthly', notes: 'Pheromone traps in the dry store' },
    { type: 'Rodent bait audit', frequency: '6monthly', notes: 'Full audit of every bait station' },
    { type: 'Termite inspection', frequency: 'annually', notes: 'Timber framing in Building C' },
    { type: 'Wasp nest removal', frequency: 'oneoff', notes: 'On request' },
  ].map(s => {
    const f = { monthly: 1, annually: 12, quarterly: 3, bimonthly: 2, '6monthly': 6 }[s.frequency];
    const last = new Date(now.getFullYear(), now.getMonth() - (f ? int(0, f - 1) : 1), int(3, 20));
    const next = f ? new Date(last.getFullYear(), last.getMonth() + f, last.getDate()) : null;
    return Object.assign({ id: uuid(), lastDone: day(last > now ? new Date(now.getTime() - DAY) : last), nextDue: next ? day(next) : '' }, s);
  });
  const r = insert('clients', {
    Name: SITE_NAME, Address: '400 Kauri Coast Road, Dargaville', Contact: 'Grace Whitfield 021 555 0101', Email: 'grace@kauricoast.example.invalid', Notes: HUGE_MARK,
    services, contract_start: day(monthStart(t0)), contract_end: day(new Date(now.getFullYear() + 2, 5, 30)), contract_notes: 'Test: 3-yearly contract, renewed twice. Monthly service plus extras.', created_at: iso(monthStart(t0)),
  });
  site = String(r.lastInsertRowid);
  const sid = Number(site);
  const ev = (at, action, title, detail, station, tech) => insert('site_events', { id: uuid(), client_id: site, action, title, detail: detail || null, station: station || null, technician: tech || null, at: iso(at), created_at: iso(at) });
  db.prepare('UPDATE clients SET image_path = ? WHERE id = ?').run(putFile(PHOTO_BUCKET, `site-covers/${site}/HUGE_cover.png`, photo(7), 'image/png'), sid);
  ev(monthStart(t0), 'site_edit', 'Site added', 'Kauri Coast Foods', null, TECHS[0]);
  for (const f of STANDARD_FOLDERS) insert('site_document_folders', { id: uuid(), client_id: site, name: f, created_by: 'Test data', created_at: iso(monthStart(t0)) });
  CONTACTS.forEach(([name, role, primary], i) => insert('site_contacts', { id: uuid(), client_id: site, name, role, phone: `021 555 ${String(1001 + i * 7).slice(-4)}`,
    email: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@kauricoast.example.invalid', notes: i === 4 ? 'Call before any chemical use' : i === 11 ? 'Gate codes and after-hours access' : null, is_primary: !!primary, sort: i, created_by: 'Test data', created_at: iso(monthStart(t0)) }));

  // ---------- buildings, floor plans (drawn) and critical limits ----------
  const plans = [];
  BUILDINGS.forEach((b, bi) => {
    const bid = uuid();
    const built = monthStart(t0 - Math.min(t0 - 1, Math.max(...b.plans.map(p => p[3]))));
    insert('site_buildings', { id: bid, client_id: site, name: b.name, sort: bi + 1, created_by: TECHS[0], created_at: iso(built), updated_at: iso(built) });
    b.plans.forEach((p, pi) => {
      const [name, cols, rows, after, share, outside] = p;
      const fp = outside ? grounds() : floorPlan(cols, rows), id = uuid(), at = monthStart(Math.max(1, t0 - after));
      const image = putFile(PHOTO_BUCKET, `${site}/HUGE_plan_${bi + 1}_${pi + 1}.png`, fp.png, 'image/png');
      insert('site_maps', { id, client_id: site, name, image_path: image, width: fp.w, height: fp.h, sort: plans.length + 1, created_by: TECHS[0], building_id: bid, created_at: iso(at), updated_at: iso(at) });
      ev(at, 'floor_plan', `Floor plan "${name}" added`, b.name, null, TECHS[0]);
      plans.push({ id, name, building: b.name, after: Math.min(after, t0 - 1), share, outside: !!outside, spot: fp.spot });
    });
  });
  const LIMITS = [
    { name: 'Production hall', rules: [{ species: FLYING[0], max: 60 }, { species: FLYING[1], max: 200 }, { species: FLYING[2], max: 20 }, { species: CRAWLING[0], max: 8 }] },
    { name: 'Warehouse', rules: [{ species: FLYING[0], max: 80 }, { species: CRAWLING[0], max: 12 }, { species: FLYING[3], max: 25 }] },
    { name: 'Cold store', rules: [{ species: FLYING[0], max: 30 }] },
    { name: 'Canteen', rules: [{ species: FLYING[0], max: 40 }, { species: CRAWLING[0], max: 6 }, { species: CRAWLING[2], max: 30 }] },
  ].map(l => Object.assign(l, { id: uuid() }));
  for (const l of LIMITS) insert('site_limits', { id: l.id, client_id: site, name: l.name, rules: l.rules, created_by: 'Test data', created_at: iso(monthStart(t0)), updated_at: iso(monthStart(t0)) });
  const limitFor = plan => /Production/.test(plan.building) ? LIMITS[0] : /Warehouse|Dispatch/.test(plan.building) ? LIMITS[1] : /Cold/.test(plan.building) ? LIMITS[2] : /canteen/i.test(plan.building) ? LIMITS[3] : null;

  // ---------- stations: every type, on the plans, installed in three stages (and some taken out later) ----------
  const inside = plans.filter(p => !p.outside), outsidePlan = plans.find(p => p.outside);
  const stations = [];
  let n = 0;
  for (const [type, short, base] of TYPES) {
    const k = Math.max(4, Math.round(base * scale));
    for (let i = 1; i <= k; i++) {
      const plan = isExt(type) ? outsidePlan : (() => { let x = rnd() * inside.reduce((s, p) => s + p.share, 0); for (const p of inside) { x -= p.share; if (x <= 0) return p; } return inside[0]; })();
      const pos = plan.spot();
      n++;
      stations.push({ id: uuid(), barcode: `HUGE-${String(n).padStart(5, '0')}`, name: `${plan.outside ? 'Yard' : plan.building.split(' - ')[0].replace('Building ', '')}-${short} ${String(i).padStart(3, '0')}`, type, plan,
        x: Math.round(pos.x * 10000) / 10000, y: Math.round(pos.y * 10000) / 10000, installed: plan.after, hot: chance(0.04) ? int(3, 6) : chance(0.15) ? 2 : 1,
        limit: (isFly(type) || isCrawl(type)) ? limitFor(plan) : null, photo: null });
    }
  }
  // stage 2 and 3 buildings came later; 60 Mezzanine stations were taken out in year 8 (their history stays)
  const removedAt = Math.min(t0 - 2, 96);
  const mezz = stations.filter(s => s.plan.name === 'Mezzanine');
  const removed = new Set(shuffle(mezz.slice()).slice(0, Math.min(60, Math.floor(mezz.length / 3))).map(s => s.barcode));
  stations.forEach((s, i) => { if (i % 50 === 0) s.photo = putFile(PHOTO_BUCKET, `${site}/HUGE_station_${s.barcode}.png`, photo(i), 'image/png'); });
  for (const s of stations) {
    if (removed.has(s.barcode)) continue;
    const at = monthStart(t0 - s.installed);
    insert('stations', { id: s.id, client_id: site, barcode: s.barcode, name: s.name, type: s.type, map_id: s.plan.id, pin_x: s.x, pin_y: s.y, limit_id: s.limit ? s.limit.id : null,
      photo_path: s.photo, created_by: TECHS[0], created_at: iso(at), updated_at: iso(at) });
  }

  // ---------- 10 years of visits ----------
  const season = m => [1.6, 1.7, 1.4, 1.0, 0.6, 0.4, 0.3, 0.4, 0.6, 0.9, 1.2, 1.5][m];
  let checks = 0, visitN = 0, extraVisits = 0;
  const vcount = {};
  const visit = (type, start, end, lead, services, notes, extraRow) => {
    visitN++; vcount[type] = (vcount[type] || 0) + 1;
    const signed = type === 'Meeting' || chance(0.93);
    insert('visits', Object.assign({ id: uuid(), client_id: site, visit_type: type, technician: lead, started_at: iso(start), signed_in_at: iso(start), completed_at: iso(end), signed_out_at: iso(end),
      notes, services_completed: services, unscanned_count: 0, signed_by: signed ? pick(SIGNERS) : null, signed_at: signed ? iso(end) : null,
      no_signature_reason: signed ? null : pick(['Site contact unavailable', 'After-hours call out', 'Client asked for the report by email']), created_at: iso(end) }, extraRow || {}));
  };
  // one station check (a record like the Service App saves)
  const check = (s, at, tech, mood, yr, q, extraNotes) => {
    const m = new Date(at).getMonth(), f = season(m) * s.hot * mood;
    const p = { locationName: s.name, deviceType: s.type, technician: tech, servicedAt: iso(at), notes: extraNotes || '' };
    if (isFly(s.type)) {
      const main = Math.round(int(3, 25) * f), more = [];
      for (const x of FLYING.slice(1, 4)) { const c = Math.round(int(0, x === FLYING[1] ? 90 : 12) * f); if (c) more.push({ species: x, activity: 'Caught', count: c }); }
      Object.assign(p, main ? { activityLevel: 'Caught', speciesCaught: FLYING[0], pestCount: main } : { activityLevel: 'None', speciesCaught: 'None' }, { morePests: more }, prep('Glue Board', 1, yr, q));
    } else if (isCrawl(s.type)) {
      const c = Math.round(int(0, 6) * f * (chance(0.6) ? 0 : 1));
      const sp2 = pick(CRAWLING);
      Object.assign(p, c ? { activityLevel: 'Caught', speciesCaught: sp2, pestCount: c } : { activityLevel: 'None', speciesCaught: 'None' },
        c > 2 ? prep(pick(['Advion Cockroach Gel', 'Anteater Ant Gel', 'Dust to Dust', 'MAC Slay Residual Insecticide']), int(2, 15), yr, q) : prep('Glue Board', 1, yr, q));
    } else if (isLook(s.type)) {
      const seen = chance(0.08 * Math.min(3, f));
      Object.assign(p, seen ? { activityLevel: pick(['Low', 'Medium']), speciesCaught: pick(RODENTS.concat(CRAWLING.slice(0, 3), FLYING.slice(0, 1))), notes: (p.notes ? p.notes + '. ' : '') + pick(['Seen by staff - checked and treated', 'Droppings found and cleaned', 'Gap found and reported']) } : { activityLevel: 'None', speciesCaught: 'None' },
        seen ? prep(pick(['Key Aqua Delta', 'Zetapy']), int(50, 400), yr, q) : { prepUsed: 'None - Monitoring Only' });
    } else if (isToxic(s.type)) {
      const lv = pick(['None', 'None', 'None', 'Low', 'Low', 'Medium', 'High'].slice(0, s.hot > 1 ? 7 : 5));
      Object.assign(p, { activityLevel: lv, speciesCaught: lv === 'None' ? 'None' : pick(RODENTS) }, prep(pick(['Contrac', 'Generation', 'Maki Block']), lv === 'None' ? int(0, 1) || 1 : int(2, 6), yr, q));
    } else if (isRodentT(s.type)) {
      const c = chance(0.06 * s.hot * season(m)) ? int(1, 3) : 0;
      Object.assign(p, c ? { activityLevel: 'Caught', speciesCaught: pick(RODENTS), pestCount: c } : { activityLevel: 'None', speciesCaught: 'None' }, c ? prep('STORGARD', 1, yr, q) : { prepUsed: 'None - Monitoring Only' });
    } else {
      const c = chance(0.1 * f) ? int(1, 5) : 0;
      Object.assign(p, c ? { activityLevel: 'Caught', speciesCaught: pick(FLYING.concat(CRAWLING)), pestCount: c } : { activityLevel: 'None', speciesCaught: 'None' }, prep(pick(['STORGARD', 'Glue Board']), 1, yr, q));
    }
    insert('service_logs', { client_id: sid, barcode_id: s.barcode, payload: p, created_at: p.servicedAt });
    checks++;
  };
  const alive = back => stations.filter(s => t0 - s.installed >= back && !(removed.has(s.barcode) && back < t0 - removedAt));
  // how many visits a month: mostly one, sometimes up to five
  const visitsThisMonth = () => { const x = rnd(); return x < 0.55 ? 1 : x < 0.78 ? 2 : x < 0.9 ? 3 : x < 0.96 ? 4 : 5; };
  for (let back = t0; back >= 0; back--) {
    const ms = monthStart(back), yr = String(ms.getFullYear()).slice(-2), q = Math.floor(ms.getMonth() / 3) + 1;
    const mood = 0.7 + rnd() * 0.7 + (back < 24 ? 0.2 : 0);   // some months are busier; the last two years a bit worse
    const lead = TECHS[(t0 - back) % 4], crew = [lead, TECHS[(t0 - back + 1) % 4], TECHS[(t0 - back + 2) % 4], TECHS[(t0 - back + 3) % 4]];
    const at = (d, h, mi) => new Date(ms.getFullYear(), ms.getMonth(), d, h, mi || 0);
    // the installs: the first visit ever is the initial install; new buildings get their own install visits
    const fresh = stations.filter(s => t0 - s.installed === back);
    if (fresh.length) {
      const start = at(3, 6, 30); if (start > now) continue;
      let t = start.getTime();
      fresh.forEach((s, i) => { t += 25000; check(s, t, crew[i % 4], 0.3, yr, q, 'Installed'); });
      const end = new Date(t + 30 * 60000), first = back === t0;
      visit('Initial Install', start, end, lead, ['Routine Service'], first ? `Initial install: ${fresh.length} stations set up across the site, mapped on the floor plans and checked. Site induction done with Grace.`
        : `Stage install: ${fresh.length} new stations in ${Array.from(new Set(fresh.map(s => s.plan.building))).join(', ')}.`);
      ev(end, 'site_edit', first ? 'Initial install completed' : 'New stations installed', `${fresh.length} stations`, null, lead);
      if (first) continue;   // the routine visits start the month after the initial install
    }
    if (back === t0 - removedAt) {
      const start = at(26, 8);
      if (start <= now) {
        const gone = stations.filter(s => removed.has(s.barcode));
        let t = start.getTime(); gone.forEach(s => { t += 40000; check(s, t, lead, 0.5, yr, q, 'Removed - area converted to storage'); });
        visit('Uninstall', start, new Date(t + 20 * 60000), lead, [], `Uninstalled ${gone.length} stations from the Mezzanine (area converted to storage).`);
        ev(start, 'site_edit', 'Stations uninstalled', `${gone.length} stations from the Mezzanine`, null, lead);
      }
    }
    const total = visitsThisMonth(), list = alive(back);
    // the routine service: every station, four technicians, one long day
    const rStart = at(int(4, 12), 6, int(0, 30));
    if (rStart > now) continue;
    let t = rStart.getTime(), missed = 0;
    const services = ['Routine Service'].concat(ms.getMonth() === 8 ? ['ILT tube change'] : [], back % 3 === 0 ? ['Bird control check'] : [], back % 2 === 0 ? ['Stored product monitoring'] : [], back % 6 === 1 ? ['Rodent bait audit'] : []);
    list.forEach((s, i) => {
      if (chance(0.004)) { missed++; return; }   // now and then one can't be reached
      t += int(8, 14) * 1000;
      check(s, t, crew[i % 4], mood, yr, q, ms.getMonth() === 8 && isFly(s.type) ? 'New UV tubes fitted' : '');
    });
    if (t > now.getTime()) t = now.getTime() - 60000;
    visit('Routine Service', rStart, new Date(t + 15 * 60000), lead, services, `Monthly service: ${list.length - missed} of ${list.length} stations checked.${missed ? ` ${missed} could not be reached (locked rooms).` : ''}`, { unscanned_count: missed });
    // the other visits this month
    const kinds = shuffle(['Call Out', 'Broken Treatment', 'Technical Support', 'Meeting', 'Fogging', 'Call Out']);
    if (back % 3 === 0 && total < 2) kinds.unshift('Meeting');   // a meeting with the client at least every quarter
    for (let v = 1; v < Math.max(total, back % 3 === 0 ? 2 : 1); v++) {
      const kind = [0, 1, 11].includes(ms.getMonth()) && v === 1 ? 'Fogging' : kinds[v - 1] || 'Call Out';
      const start = at(int(14, 27), int(7, 15), int(0, 59));
      if (start > now) break;
      extraVisits++;
      const tech = pick(TECHS);
      let tt = start.getTime();
      if (kind === 'Meeting') {
        visit('Meeting', start, new Date(tt + int(30, 90) * 60000), tech, [], pick(['Quarterly review with the QA team: trends, open recommendations and the audit coming up.', 'Audit prep meeting: went through the pest map and critical limits.',
          'Met the new facilities manager; walked the site and agreed the proofing plan.', 'Contract review: services and pricing for next year.']));
        continue;
      }
      const hot = shuffle(list.filter(s => kind === 'Fogging' ? isFly(s.type) && /Production/.test(s.plan.building) : kind === 'Technical Support' ? isFly(s.type) : kind === 'Broken Treatment' ? isToxic(s.type) || isCrawl(s.type) : s.hot > 1 || chance(0.02)))
        .slice(0, kind === 'Broken Treatment' ? int(40, 150) : kind === 'Technical Support' ? int(5, 25) : kind === 'Fogging' ? int(10, 30) : int(5, 40));
      for (const s of hot) {
        tt += int(40, 120) * 1000;
        check(s, tt, tech, kind === 'Call Out' ? 1.8 : 1, yr, q, kind === 'Technical Support' ? 'Unit serviced' : kind === 'Fogging' ? 'Area fogged' : kind === 'Call Out' ? 'Call out - activity reported by staff' : 'Treatment topped up');
      }
      if (kind === 'Fogging') {
        // the fogging itself: one record on a station in the hall, with the fogging preparation
        const s = hot[0] || list.find(x => isFly(x.type)) || list[0];
        tt += 20 * 60000;
        insert('service_logs', { client_id: sid, barcode_id: s.barcode, payload: Object.assign({ locationName: s.name, deviceType: s.type, technician: tech, servicedAt: iso(tt), notes: 'Production hall fogged', activityLevel: 'None', speciesCaught: 'None' }, prep(pick(['Forgot', 'VK2']), int(2, 6), yr, q)), created_at: iso(tt) });
        checks++;
      }
      if (kind === 'Call Out' && chance(0.3)) {
        const s = pick(list); tt += 30 * 60000;
        insert('service_logs', { client_id: sid, barcode_id: s.barcode, payload: Object.assign({ locationName: s.name, deviceType: s.type, technician: tech, servicedAt: iso(tt), notes: 'Wasp nest removed nearby', activityLevel: 'High', speciesCaught: FLYING[4], pestCount: 1 }, prep('WaspJet Pro', 1, yr, q)), created_at: iso(tt) });
        checks++;
      }
      const vt = kind === 'Fogging' ? 'Routine Service' : kind;
      visit(vt, start, new Date(Math.min(tt + 10 * 60000, now.getTime())), tech, kind === 'Fogging' ? ['Fogging'] : [], {
        'Call Out': `Call out: ${pick(['rats seen in the', 'flies reported in the', 'cockroaches seen in the', 'droppings found in the'])} ${pick(plans).name.toLowerCase()} - ${hot.length} stations checked and treated.`,
        'Broken Treatment': `Broken treatment: baits and gels topped up at ${hot.length} stations.`,
        'Technical Support': `Technical support: ${hot.length} insect light traps serviced.`,
        'Fogging': `Fogging of the production hall; ${hot.length} insect light traps checked after.`,
      }[kind]);
    }
  }

  // ---------- 100 recommendations (with notes, photos, and the client's replies) ----------
  const REC = {
    'Proofing': ['Seal the gap under the {p} roller door - rodents can get in.', 'Fit a brush strip to the {p} fire door.', 'Mesh the vents above the {p}.', 'Fill the cable holes in the {p} wall.'],
    'Housekeeping': ['Clear the pallets stacked against the {p} wall - they give rats cover.', 'Sweep out spilt product under the racking in the {p}.', 'Move the bins away from the {p} door.'],
    'Hygiene': ['Deep clean behind the equipment in the {p} - cockroach harbourage found.', 'Clean the drains in the {p} - drain flies breeding.', 'Empty and clean the grease trap near the {p}.'],
    'Storage': ['Keep stock off the floor in the {p} (at least 450 mm clear).', 'Rotate the dry stock in the {p} - some bags are past date.'],
    'Structural / maintenance': ['Repair the broken ceiling tile in the {p}.', 'Replace the damaged door seal on the {p} chiller.', 'Fix the leaking pipe in the {p} - standing water attracts pests.'],
    'Pest activity': ['Rodent activity rising in the {p} - we will increase checks; please report any sightings.', 'Fly numbers over the critical limit in the {p} - keep the doors shut.'],
    'Other': ['Staff training on pest awareness for the {p} team.', 'Update the site map at reception after the {p} changes.'],
  };
  const key = 'seq:recommendations.rec_no';
  const nextRecNo = () => { const top = db.prepare('SELECT MAX(rec_no) AS m FROM recommendations').get().m || 0, meta = db.prepare('SELECT value FROM server_meta WHERE key = ?').get(key);
    const v = Math.max(Number(meta ? meta.value : 0), top) + 1; db.prepare('INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(v)); return v; };
  const recPhotos = Array.from({ length: 12 }, (_, i) => putFile(PHOTO_BUCKET, `${site}/HUGE_rec_${i + 1}.png`, photo(100 + i), 'image/png'));
  const live = stations.filter(s => !removed.has(s.barcode));
  let recs = 0, updates = 0;
  for (let i = 0; i < 100; i++) {
    const ageDays = Math.floor(Math.pow(rnd(), 1.6) * (t0 * 30 - 20)) + 1;   // more of them recent
    const at = new Date(now.getTime() - ageDays * DAY + int(8, 16) * 3600000);
    const cat = pick(Object.keys(REC)), s = chance(0.85) ? pick(live) : null, place = s ? s.plan.name.toLowerCase() : pick(['yard', 'canteen', 'loading bay']);
    const status = ageDays > 200 ? (chance(0.9) ? 'complete' : chance(0.5) ? 'pending' : 'open') : ageDays > 40 ? pick(['complete', 'complete', 'pending', 'open']) : pick(['open', 'open', 'pending']);
    const done = status === 'complete' ? new Date(Math.min(now.getTime() - DAY, at.getTime() + int(3, 60) * DAY)) : null;
    const id = uuid(), tech = pick(TECHS);
    insert('recommendations', { id, rec_no: nextRecNo(), client_id: site, station_barcode: s ? s.barcode : null, station_name: s ? s.name : null, station_type: s ? s.type : null,
      text: pick(REC[cat]).replace('{p}', place), category: cat, details: chance(0.4) ? 'Seen during the routine service. Photos attached.' : null,
      photos: chance(0.4) ? shuffle(recPhotos.slice()).slice(0, int(1, 3)) : [], status, raised_at: iso(at), raised_by: tech, completed_at: done ? iso(done) : null, created_at: iso(at), updated_at: iso(done || at) });
    recs++;
    ev(at, 'recommendation', `Recommendation raised`, pick(REC[cat]).replace('{p}', place), s ? s.name : null, tech);
    // its history: notes from the technician and replies from the client
    const steps = status === 'open' ? int(0, 1) : int(1, 3);
    for (let k = 0; k < steps; k++) {
      const uat = new Date(at.getTime() + (k + 1) * int(2, 15) * DAY);
      if (uat > now || (done && uat > done)) break;
      const byClient = chance(0.4);
      insert('recommendation_updates', { id: uuid(), rec_id: id, client_id: site, status: k === steps - 1 && status !== 'open' ? status : 'pending',
        note: byClient ? pick(['Maintenance booked for next week.', 'Done - please check on your next visit.', 'Quote approved.', 'We need more time - parts on order.']) : pick(['Checked: still to do.', 'Followed up with Hemi.', 'Partly done - one gap left.', 'Checked and fixed - closing.']),
        photos: !byClient && chance(0.25) ? [pick(recPhotos)] : [], technician: byClient ? pick(SIGNERS) : pick(TECHS), at: iso(uat), created_at: iso(uat), by_client: byClient });
      updates++;
    }
  }

  // ---------- 300 pest sightings from the client ----------
  const sightPhotos = Array.from({ length: 8 }, (_, i) => putFile(PHOTO_BUCKET, `${site}/HUGE_sighting_${i + 1}.png`, photo(200 + i), 'image/png'));
  const PLACES = ['behind the flour sacks', 'under the canteen sink', 'by the dispatch door', 'in the cool store corridor', 'near the bins', 'in the staff toilets', 'on the racking, aisle 4', 'in the plant room', 'by the loading dock', 'in the office kitchen'];
  for (let i = 1; i <= 300; i++) {
    const ageDays = Math.floor(Math.pow(rnd(), 1.3) * (t0 * 30 - 10));
    const seen = new Date(now.getTime() - ageDays * DAY - int(1, 10) * 3600000), s = chance(0.4) ? pick(live) : null;
    const status = ageDays > 30 ? (chance(0.92) ? 'reviewed' : 'actioned') : pick(['new', 'new', 'actioned', 'reviewed']);
    const act = status !== 'new' ? new Date(Math.min(now.getTime() - 3600000, seen.getTime() + int(1, 5) * DAY)) : null;
    const rev = status === 'reviewed' ? new Date(Math.min(now.getTime() - 1800000, act.getTime() + int(1, 7) * DAY)) : null;
    insert('pest_sightings', { id: uuid(), client_id: site, sighting_no: i, pest: pick(RODENTS.concat(FLYING.slice(0, 2), CRAWLING.slice(0, 3), [FLYING[4]])), location: s ? `${s.plan.building}, ${s.plan.name}` : pick(PLACES),
      station_barcode: s ? s.barcode : null, seen_at: iso(seen), number_seen: int(1, 12), evidence: pick(['Live', 'Dead', 'Droppings', 'Gnaw marks', 'Nest', 'Smear marks']), urgency: chance(0.2) ? 'Urgent' : 'Routine',
      reported_by: pick(CONTACTS)[0], reporter_contact: chance(0.5) ? '021 555 0101' : null, details: chance(0.5) ? 'Seen by the night shift.' : null, photos: chance(0.3) ? [pick(sightPhotos)] : [],
      status, action_notes: act ? pick(['Checked the area and set extra traps.', 'Treated and proofed the gap.', 'Baits topped up; no further activity.', 'Nest removed.']) : null, actioned_by: act ? pick(TECHS) : null, actioned_at: act ? iso(act) : null,
      action_photos: act && chance(0.2) ? [pick(sightPhotos)] : [], client_reviewed_by: rev ? pick(SIGNERS) : null, client_reviewed_at: rev ? iso(rev) : null, client_review_note: rev && chance(0.5) ? 'Thanks - all good.' : null,
      created_by: 'Test data', created_at: iso(seen), updated_at: iso(rev || act || seen) });
    if (i % 5 === 0) ev(seen, 'sighting', `Pest sighting PS-${i} reported`, null, null, null);
  }

  // ---------- documents (some expired, some due soon) ----------
  const DOCS = [
    ['SDS', 'Contrac Blox SDS', 400], ['SDS', 'Generation Mini-Block SDS', 300], ['SDS', 'Advion Cockroach Gel SDS', 200], ['SDS', 'MAC Slay SDS', -20], ['SDS', 'VK2 Fogging Solution SDS', 20],
    ['Service agreement', 'Service agreement 2024-2027', 500], ['Service agreement', 'Schedule of services', null],
    ['Maps', 'Site plan (hand drawn, 2016)', null], ['Site specific', 'Site induction checklist', null], ['Site specific', 'Chemical register', 60], ['Site specific', 'Risk assessment', 10],
    ['Meeting notes', 'Quarterly review - March', null], ['Meeting notes', 'Audit prep notes', null], ['Meeting notes', 'Contract review notes', null],
    ['Entomology', 'Fly identification report', null], ['Entomology', 'Stored product insect survey', null],
    ['Training', 'Pest awareness training - attendance', 200], ['Training', 'Approved handler certificate - Aroha', 25], ['Training', 'Approved handler certificate - Ben', -5],
    ['Insurance', 'Public liability certificate', 120], ['Insurance', 'Professional indemnity certificate', 3],
  ];
  DOCS.forEach(([folder, title, expDays], i) => {
    const file = putFile(DOC_BUCKET, `${site}/HUGE_doc_${i + 1}.pdf`, pdf(title, ['Kauri Coast Foods - pretend document for testing', `Folder: ${folder}`, 'Made by tools/huge_site.mjs']), 'application/pdf');
    const at = new Date(now.getTime() - int(30, t0 * 25) * DAY);
    insert('site_documents', { id: uuid(), client_id: site, category: folder, folder, title, file_path: file, file_name: title.replace(/[^\w\- ]+/g, '') + '.pdf', mime_type: 'application/pdf', size_bytes: fs.statSync(path.join(filesDir, DOC_BUCKET, ...file.split('/'))).size,
      expires_on: expDays == null ? null : day(new Date(now.getTime() + expDays * DAY)), notes: chance(0.3) ? 'Test document' : null, uploaded_by: 'Test data', created_at: iso(at), updated_at: iso(at) });
  });

  // ---------- a little more in the activity log ----------
  ev(monthStart(t0 - 1), 'services_edit', 'Services & schedule updated', services.map(s => s.type).join(', '), null, TECHS[0]);
  ev(monthStart(36), 'site_edit', 'Contract renewed', 'Three more years', null, TECHS[0]);
  ev(monthStart(12), 'limit_breach', 'Critical limit exceeded', 'Fly over the limit at a production hall ILT', null, TECHS[1]);

  // ---------- let a client login see it (it must already be a client login, made in Admin) ----------
  const email = (opt('client') || '').trim().toLowerCase();
  if (email) {
    if (db.prepare('SELECT 1 FROM client_users WHERE email = ?').get(email)) insert('client_access', { email, client_id: site, added_by: 'Test data', added_at: iso(now) });
    else console.log(`(${email} isn't a client login yet - add it in Admin, then tick the huge site for it.)`);
  }
  summary = `Added huge test site #${site} "${SITE_NAME}": ${stations.length - removed.size} stations (${removed.size} more were taken out in year 8) of ${TYPES.length} types, `
    + `${BUILDINGS.length} buildings, ${plans.length} floor plans with every station pinned, ${visitN} visits over ${YEARS} years (${Object.entries(vcount).map(([k, v]) => `${v} ${k}`).join(', ')}), `
    + `${checks.toLocaleString('en-NZ')} station checks, ${recs} recommendations (${updates} notes), 300 pest sightings, ${CONTACTS.length} contacts, ${services.length} services, ${LIMITS.length} critical limits, ${DOCS.length} documents.`;
});
console.log(summary);
db.exec('PRAGMA wal_checkpoint(PASSIVE)');
const size = ['', '-wal'].reduce((n, x) => n + (fs.existsSync(dbPath + x) ? fs.statSync(dbPath + x).size : 0), 0);
console.log(`Took ${Math.round((Date.now() - started) / 1000)} seconds. The database is now ${Math.round(size / 1048576)} MB.`);
