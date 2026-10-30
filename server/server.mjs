// Pestis server: the database (SQLite), sign-in (Google, or an emailed link for clients), photo and document storage,
// and live updates for the Service App, Admin and the Client Portal. It serves the three apps too.
// Needs Node.js 22.13+ (built-in node:sqlite; no npm install).
//
// Settings (environment variables, normally in /etc/pestis.env):
//   GOOGLE_CLIENT_ID   OAuth "Web application" client ID (Google sign-in)
//   ADMIN_EMAILS       comma-separated emails that are always approved admins
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE (ssl | starttls | none)
//                      optional: lets clients get an emailed sign-in link
//   SESSION_DAYS       how long a sign-in lasts without being used (default 30; the apps also sign out after the
//                      idle time set in Admin -> Team settings, 5 minutes to start with)
//   DATA_DIR           database and files (default /var/lib/pestis)
//   PUBLIC_DIR         the apps (default: the folder above this one)

import http from 'node:http';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES, SEED, STANDARD_FOLDERS, SITE_TABLES, LIST_TABLES, LIVE_TABLES, BUCKETS } from './schema.mjs';
import { sendMail } from './mail.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/var/lib/pestis');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'pestis.db');
const FILES_DIR = path.join(DATA_DIR, 'files');
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(HERE, '..'));
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CERTS_URL = process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_MS = Number(process.env.SESSION_DAYS || 30) * 86400000;
const SMTP = { host: process.env.SMTP_HOST || '', port: Number(process.env.SMTP_PORT || 587), user: process.env.SMTP_USER || '', pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || '', secure: process.env.SMTP_SECURE || '' };
const MAIL_ON = !!(SMTP.host && SMTP.from);
const MAX_JSON = 30 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT, avatar_url TEXT, provider TEXT,
    created_at TEXT NOT NULL, last_sign_in_at TEXT
  );
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, agent TEXT
  );
  CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions (user_id);
  CREATE TABLE IF NOT EXISTS auth_links (
    token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, redirect_to TEXT, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS storage_objects (
    bucket TEXT NOT NULL, name TEXT NOT NULL, mime TEXT, size INTEGER, owner TEXT, created_at TEXT, updated_at TEXT,
    PRIMARY KEY (bucket, name)
  );
  CREATE TABLE IF NOT EXISTS server_meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS extra_columns (tbl TEXT NOT NULL, col TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (tbl, col));
`);
const metaGet = k => db.prepare('SELECT value FROM server_meta WHERE key = ?').get(k)?.value;
const metaSet = (k, v) => db.prepare('INSERT INTO server_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(k, String(v));
if (!metaGet('secret')) metaSet('secret', crypto.randomBytes(32).toString('hex'));
const SECRET = metaGet('secret');

/* =====================================================================================
   Tables
   ===================================================================================== */
const q = s => '"' + String(s).replace(/"/g, '""') + '"';
const SQLTYPE = { int: 'INTEGER', real: 'REAL', bool: 'INTEGER' };
const T = {};   // name -> { name, pk, identity, cols: Map(name -> {type, def, nn, oneOf}) }
function loadTables() {
  for (const [name, def] of Object.entries(TABLES)) {
    T[name] = { name, pk: def.pk, identity: def.identity || null, cols: new Map(Object.entries(def.cols)) };
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!exists) {
      const parts = [];
      for (const [col, cd] of Object.entries(def.cols)) {
        if (def.identity === col && def.pk.length === 1 && def.pk[0] === col) parts.push(`${q(col)} INTEGER PRIMARY KEY AUTOINCREMENT`);
        else parts.push(`${q(col)} ${SQLTYPE[cd.type] || 'TEXT'}`);
      }
      if (!(def.identity && def.pk.length === 1 && def.pk[0] === def.identity)) parts.push(`PRIMARY KEY (${def.pk.map(q).join(', ')})`);
      db.exec(`CREATE TABLE ${q(name)} (${parts.join(', ')})`);
    } else {
      const have = new Set(db.prepare(`SELECT name FROM pragma_table_info(?)`).all(name).map(r => r.name));
      for (const [col, cd] of Object.entries(def.cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${q(name)} ADD COLUMN ${q(col)} ${SQLTYPE[cd.type] || 'TEXT'}`);
    }
    for (const u of def.unique || []) db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(name + '_' + u.join('_') + '_key')} ON ${q(name)} (${u.map(q).join(', ')})`);
    for (const ix of def.index || []) db.exec(`CREATE INDEX IF NOT EXISTS ${q(name + '_' + ix.join('_') + '_idx')} ON ${q(name)} (${ix.map(q).join(', ')})`);
  }
  // columns the apps started saving that aren't in schema.mjs (added automatically, see addColumn)
  for (const r of db.prepare('SELECT tbl, col, type FROM extra_columns').all()) if (T[r.tbl] && !T[r.tbl].cols.has(r.col)) T[r.tbl].cols.set(r.col, { type: r.type });
}
loadTables();
db.exec(`CREATE INDEX IF NOT EXISTS service_logs_client_ref_idx ON service_logs (client_id, json_extract(payload, '$.clientRef'))`);

function addColumn(t, col, sample) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(col)) throw new PgError('42703', `column "${col}" of relation "${t.name}" does not exist`);
  const type = typeof sample === 'boolean' ? 'bool' : typeof sample === 'number' ? 'real' : sample && typeof sample === 'object' ? 'json' : 'text';
  db.exec(`ALTER TABLE ${q(t.name)} ADD COLUMN ${q(col)} ${SQLTYPE[type] || 'TEXT'}`);
  db.prepare('INSERT OR IGNORE INTO extra_columns (tbl, col, type) VALUES (?, ?, ?)').run(t.name, col, type);
  t.cols.set(col, { type });
  console.log(`Added column ${t.name}.${col} (${type}) - the app saved a value for it`);
}

class PgError extends Error {
  constructor(code, message, status = 400, details = null, hint = null) { super(message); this.code = code; this.status = status; this.details = details; this.hint = hint; }
}

/* ---------- values ---------- */
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
function toDb(type, v, col) {
  if (v === undefined || v === null) return null;
  switch (type) {
    case 'int': {
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
      if (!Number.isFinite(n) || !Number.isInteger(n)) throw new PgError('22P02', `invalid input syntax for type bigint: "${String(v).slice(0, 60)}"`);
      return n;
    }
    case 'real': {
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
      if (!Number.isFinite(n)) throw new PgError('22P02', `invalid input syntax for type double precision: "${String(v).slice(0, 60)}"`);
      return n;
    }
    case 'bool':
      if (v === true || v === 1 || /^(true|t|1|yes|on)$/i.test(String(v))) return 1;
      if (v === false || v === 0 || /^(false|f|0|no|off)$/i.test(String(v))) return 0;
      throw new PgError('22P02', `invalid input syntax for type boolean: "${String(v).slice(0, 60)}"`);
    case 'json': return JSON.stringify(v);
    case 'ts': {
      const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
      if (isNaN(d.getTime()) || v === '') throw new PgError('22007', `invalid input syntax for type timestamp with time zone: "${String(v).slice(0, 60)}"`);
      return d.toISOString();
    }
    case 'date': {
      const s = String(v);
      if (DATE_RE.test(s) && !/[T ]\d/.test(s.slice(10, 12))) return s.slice(0, 10);
      const d = new Date(s);
      if (isNaN(d.getTime()) || s === '') throw new PgError('22007', `invalid input syntax for type date: "${s.slice(0, 60)}"`);
      return DATE_RE.test(s) ? s.slice(0, 10) : d.toISOString().slice(0, 10);
    }
    case 'uuid': {
      const s = String(v).trim().toLowerCase();
      if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/.test(s)) throw new PgError('22P02', `invalid input syntax for type uuid: "${String(v).slice(0, 60)}"`);
      return s;
    }
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}
function fromDb(type, v) {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'bool': return !!v;
    case 'json': try { return JSON.parse(v); } catch { return v; }
    case 'int': case 'real': return typeof v === 'number' ? v : Number(v);
    default: return typeof v === 'string' ? v : String(v);
  }
}
function decodeRow(t, raw) {
  if (!raw) return null;
  const out = {};
  for (const [col, cd] of t.cols) out[col] = fromDb(cd.type, raw[col]);
  return out;
}
const table = name => {
  const t = Object.prototype.hasOwnProperty.call(T, name) ? T[name] : null;
  if (!t) throw new PgError('PGRST205', `Could not find the table 'public.${name}' in the schema cache`, 404, null, null);
  return t;
};

/* =====================================================================================
   Who is asking
   ===================================================================================== */
const SYSTEM = { uid: null, email: null, approved: true, admin: true, client: false, sites: new Set(), system: true };
let accessVersion = 0;   // bumped whenever staff approval or client access changes (live connections re-check)
function ctxFor(userId) {
  const u = db.prepare('SELECT * FROM auth_users WHERE id = ?').get(userId);
  if (!u) return null;
  const email = String(u.email).toLowerCase();
  const p = db.prepare('SELECT approved, role, full_name FROM profiles WHERE id = ?').get(userId);
  const cu = db.prepare('SELECT active, full_name, company FROM client_users WHERE email = ?').get(email);
  const client = !!(cu && cu.active);
  const sites = new Set(client ? db.prepare('SELECT client_id FROM client_access WHERE email = ?').all(email).map(r => String(r.client_id)) : []);
  return { uid: userId, email, approved: !!(p && p.approved), admin: !!(p && p.approved && p.role === 'admin'), client, sites,
    staffName: p ? (p.full_name || email) : null, clientUser: cu || null, user: u, version: accessVersion };
}
const canSeeSite = (me, cid) => me.approved || (me.client && me.sites.has(String(cid)));
const isSiteClient = (me, cid) => me.client && me.sites.has(String(cid));
function myName(me) {
  if (me.client && !me.approved && me.clientUser) return (me.clientUser.full_name || me.email) + (me.clientUser.company ? ' · ' + me.clientUser.company : '') + ' (client)';
  return me.staffName || me.email;
}

/* ---------- visits in progress: clients see the results once the visit is finished ---------- */
// While a technician has a visit open at a site, its client logins don't see anything the server received since the
// visit started (clients.visit_hold_from, the server's own time, so it compares with created_at on the same clock).
// When the visit is closed it all appears at once (releaseVisitHold).
const VISIT_HOLD = new Set(['service_logs', 'recommendations', 'recommendation_updates', 'stations', 'site_maps', 'visits']);
function visitHoldSql(tn) {
  const t = q(tn);
  const held = `EXISTS (SELECT 1 FROM "clients" h WHERE CAST(h."id" AS TEXT) = CAST(${t}."client_id" AS TEXT) AND h."visit_hold_from" IS NOT NULL
    AND ${t}."created_at" >= h."visit_hold_from")`;
  return tn === 'recommendation_updates' ? `(${t}."by_client" = 1 OR NOT ${held})` : `NOT ${held}`;   // a client's own updates always show
}
function heldFromClients(tn, row) {
  if (!VISIT_HOLD.has(tn) || !row || (tn === 'recommendation_updates' && row.by_client)) return false;
  const c = db.prepare('SELECT visit_hold_from FROM clients WHERE CAST(id AS TEXT) = ?').get(String(row.client_id));
  return !!(c && c.visit_hold_from && String(row.created_at) >= c.visit_hold_from);
}
// the visit is closed: send what was held back to the client logins watching live
function releaseVisitHold(cid, from) {
  if (!from) return;
  const cut = from;
  for (const tn of VISIT_HOLD) {
    for (const row of sys.all(tn, [['client_id', 'eq', tn === 'service_logs' ? Number(cid) : String(cid)], ['created_at', 'gte', cut]])) {
      if (tn === 'recommendation_updates' && row.by_client) continue;
      events.push({ table: tn, type: 'INSERT', row, old: null, clientsOnly: true });
    }
  }
}

/* ---------- read rules: which rows someone can see ---------- */
// returns 'all', 'none' or { sql, params }
function readRule(tn, me) {
  if (me.system) return 'all';
  const inSites = () => me.sites.size ? { sql: `CAST("client_id" AS TEXT) IN (${[...me.sites].map(() => '?').join(', ')})${VISIT_HOLD.has(tn) ? ' AND ' + visitHoldSql(tn) : ''}`, params: [...me.sites] } : 'none';
  switch (tn) {
    case 'profiles': return me.approved ? 'all' : { sql: '"id" = ?', params: [me.uid] };
    case 'allowed_emails': return me.admin ? 'all' : 'none';
    case 'client_users': return me.approved ? 'all' : 'none';
    case 'client_access': return me.approved ? 'all' : { sql: '"email" = ?', params: [me.email] };
    case 'user_prefs': return { sql: '"user_id" = ?', params: [me.uid] };
    case 'staff_days': return me.admin ? 'all' : { sql: '"user_id" = ?', params: [me.uid] };
    case 'site_contacts': return me.approved ? 'all' : me.client ? inSites() : 'none';
    case 'clients': case 'site_events': case 'app_settings': return me.approved ? 'all' : 'none';
  }
  if (SITE_TABLES.has(tn)) return me.approved ? 'all' : me.client ? inSites() : 'none';
  if (LIST_TABLES.has(tn)) return me.approved || me.client ? 'all' : 'none';
  return 'none';
}
function canRead(tn, row, me) {
  const r = readRule(tn, me);
  if (r === 'all') return true;
  if (r === 'none' || !row) return false;
  switch (tn) {
    case 'profiles': return row.id === me.uid;
    case 'client_access': return row.email === me.email;
    case 'user_prefs': case 'staff_days': return row.user_id === me.uid;
    default: return me.sites.has(String(row.client_id)) && !heldFromClients(tn, row);
  }
}

/* ---------- write rules ---------- */
const GUARDED = new Set([...SITE_TABLES, ...LIST_TABLES, 'clients', 'site_events', 'app_settings']);
// a client adds their own files to their site's Meetings folder, and removes only the ones they added
const clientMeetingDoc = (op, row, me) => me.client && !me.approved && row && isSiteClient(me, row.client_id) && /^meetings$/i.test(String(row.folder || '').trim())
  && clientMeetingFile(me, String(row.file_path || '')) && (op === 'insert' || row.uploaded_by_id === me.uid);
function canWrite(tn, op, row, me) {
  if (me.system) return true;
  if (tn === 'site_documents' && clientMeetingDoc(op, row, me)) return true;
  if (GUARDED.has(tn) && !me.approved) return false;
  switch (tn) {
    case 'service_logs': case 'recommendations': case 'recommendation_updates': case 'stations': case 'site_maps': case 'visits':
    case 'site_events': case 'clients': return me.approved;
    case 'site_documents': case 'site_document_folders': case 'site_limits': return me.admin;
    case 'pest_sightings': return op !== 'delete' && me.approved;
    case 'recommendation_views': case 'recommendation_view_log': return false;   // only through pestis_mark_rec_viewed
    case 'preparations': case 'species': case 'station_types': case 'app_settings': return me.admin;
    case 'site_contacts': return me.approved || isSiteClient(me, row.client_id);
    case 'client_users': case 'client_access': case 'allowed_emails': return me.admin;
    case 'profiles': return op === 'update' ? (me.admin || row.id === me.uid) : op === 'delete' ? me.admin : false;
    case 'staff_days': return op === 'insert' ? (row.user_id === me.uid && me.approved) : op === 'update' ? row.user_id === me.uid : false;
    default: return false;
  }
}
const rlsError = tn => new PgError('42501', `new row violates row-level security policy for table "${tn}"`, 403);

/* =====================================================================================
   Queries
   ===================================================================================== */
function colExpr(t, name) {
  // plain column, or a value inside a JSON column: payload->>clientRef, payload->a->>b
  const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:->>?[A-Za-z0-9_]+)+)$/.exec(name);
  if (m) {
    const cd = t.cols.get(m[1]);
    if (!cd) throw new PgError('42703', `column ${t.name}.${m[1]} does not exist`);
    const keys = [...m[2].matchAll(/->(>?)([A-Za-z0-9_]+)/g)];
    const pathStr = '$' + keys.map(k => /^\d+$/.test(k[2]) ? `[${k[2]}]` : '.' + k[2]).join('');
    const asText = keys[keys.length - 1][1] === '>';
    return { sql: asText ? `CAST(json_extract(${q(m[1])}, '${pathStr}') AS TEXT)` : `json_extract(${q(m[1])}, '${pathStr}')`, type: 'text', json: true };
  }
  const cd = t.cols.get(name);
  if (!cd) throw new PgError('42703', `column ${t.name}.${name} does not exist`);
  return { sql: q(name), type: cd.type };
}
function filterSql(t, f, params) {
  let [col, op, val] = f;
  const e = colExpr(t, col);
  const conv = v => e.json ? (v === null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v)) : toDb(e.type, v, col);
  const ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  if (ops[op]) {
    if (val === null) return op === 'neq' ? `${e.sql} IS NOT NULL` : op === 'eq' ? `${e.sql} IS NULL` : '0';
    params.push(conv(val)); return `${e.sql} ${ops[op]} ?`;
  }
  if (op === 'in') {
    const list = (Array.isArray(val) ? val : String(val).replace(/^\(|\)$/g, '').split(',')).filter(v => v !== undefined);
    const vals = list.filter(v => v !== null), hasNull = vals.length < list.length;
    const parts = [];
    if (vals.length) { for (const v of vals) params.push(conv(v)); parts.push(`${e.sql} IN (${vals.map(() => '?').join(', ')})`); }
    if (hasNull) parts.push(`${e.sql} IS NULL`);
    return parts.length ? '(' + parts.join(' OR ') + ')' : '0';
  }
  if (op === 'is') {
    const s = val === null ? 'null' : String(val).toLowerCase();
    if (s === 'null') return `${e.sql} IS NULL`;
    if (s === 'true') return `${e.sql} = 1`;
    if (s === 'false') return `${e.sql} = 0`;
    throw new PgError('22P02', `invalid input for "is": ${val}`);
  }
  if (op === 'like' || op === 'ilike') {
    params.push(String(val).replace(/\*/g, '%'));
    return `${e.sql} LIKE ?`;
  }
  if (op === 'cs' || op === 'contains') {   // a JSON array column contains every value given
    const arr = Array.isArray(val) ? val : [val];
    if (!arr.length) return '1';
    return '(' + arr.map(v => { params.push(typeof v === 'object' ? JSON.stringify(v) : v); return `EXISTS (SELECT 1 FROM json_each(${e.sql}) WHERE value = ?)`; }).join(' AND ') + ')';
  }
  throw new PgError('PGRST100', `Unsupported filter "${op}"`);
}
function whereSql(t, filters, params) {
  const parts = [];
  for (const f of filters || []) {
    if (!Array.isArray(f) || f.length < 3) throw new PgError('PGRST100', 'Bad filter');
    if (f[1] === 'not') parts.push(`NOT (${filterSql(t, [f[0], f[2], f[3]], params)})`);
    else parts.push(filterSql(t, f, params));
  }
  return parts;
}
function parseSelect(t, s) {
  const str = String(s == null ? '*' : s).replace(/\s+/g, '');
  if (str === '' || str === '*') return null;
  if (/[()]/.test(str)) throw new PgError('PGRST100', 'Related tables in select() are not supported by this server');
  return str.split(',').filter(Boolean).map(p => {
    const [alias, col] = p.includes(':') ? p.split(':') : [p, p];
    const name = col.replace(/::\w+$/, '');
    if (name === '*') return { all: true };
    if (!t.cols.has(name)) throw new PgError('42703', `column ${t.name}.${name} does not exist`);
    return { alias, name };
  });
}
function project(row, cols) {
  if (!cols) return row;
  const out = {};
  for (const c of cols) { if (c.all) Object.assign(out, row); else out[c.alias] = row[c.name]; }
  return out;
}
function orderSql(t, order) {
  return (order || []).map(o => {
    const [col, asc = true, nullsFirst] = Array.isArray(o) ? o : [o.column, o.ascending !== false, o.nullsFirst];
    const e = colExpr(t, col);
    const nf = nullsFirst === undefined || nullsFirst === null ? !asc : !!nullsFirst;   // like Postgres: nulls last going up, first going down
    const coll = e.type === 'text' || e.type === 'uuid' ? ' COLLATE NOCASE' : '';
    return `(${e.sql} IS NULL) ${nf ? 'DESC' : 'ASC'}, ${e.sql}${coll} ${asc ? 'ASC' : 'DESC'}`;
  });
}

function runSelect(t, qr, me) {
  const cols = parseSelect(t, qr.select);
  const params = [];
  const where = whereSql(t, qr.filters, params);
  const rule = readRule(t.name, me);
  if (rule === 'none') return { data: qr.head ? null : [], count: qr.count ? 0 : null };
  if (rule !== 'all') { where.push(rule.sql); params.push(...rule.params); }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  let count = null;
  if (qr.count) count = db.prepare(`SELECT COUNT(*) AS n FROM ${q(t.name)}${w}`).get(...params).n;
  if (qr.head) return { data: null, count };
  const ord = orderSql(t, qr.order);
  let sql = `SELECT * FROM ${q(t.name)}${w}${ord.length ? ' ORDER BY ' + ord.join(', ') : ' ORDER BY rowid'}`;
  const lim = qr.limit != null ? Math.max(0, Math.floor(Number(qr.limit))) : null, off = qr.offset != null ? Math.max(0, Math.floor(Number(qr.offset))) : 0;
  if (lim != null || off) { sql += ' LIMIT ? OFFSET ?'; params.push(lim != null ? lim : -1, off); }
  const rows = db.prepare(sql).all(...params).map(r => project(decodeRow(t, r), cols));
  return { data: rows, count };
}

/* ---------- writes ---------- */
let events = [];      // live updates waiting for the change to be saved
const emit = (tn, type, row, old) => { if (LIVE_TABLES.has(tn)) events.push({ table: tn, type, row, old }); };

function fillDefaults(t, row, me) {
  const out = Object.assign({}, row);
  for (const [col, cd] of t.cols) {
    if (out[col] !== undefined && !(out[col] === null && cd.def === 'identity')) continue;
    if (cd.def === undefined) continue;
    if (cd.def === 'now') out[col] = new Date().toISOString();
    else if (cd.def === 'uid') out[col] = me.uid || null;
    else if (cd.def === 'uuid') out[col] = crypto.randomUUID();
    else if (cd.def === 'identity') { if (t.identity === col && t.pk[0] !== col) out[col] = nextSeq(t, col); else delete out[col]; }
    else out[col] = typeof cd.def === 'object' ? JSON.parse(JSON.stringify(cd.def)) : cd.def;
  }
  return out;
}
function nextSeq(t, col) {
  const key = `seq:${t.name}.${col}`;
  const top = db.prepare(`SELECT MAX(${q(col)}) AS m FROM ${q(t.name)}`).get().m || 0;
  const n = Math.max(Number(metaGet(key) || 0), top) + 1;
  metaSet(key, n);
  return n;
}
function encodeRow(t, row) {
  const cols = [], vals = [];
  for (const [col, v] of Object.entries(row)) {
    if (v === undefined) continue;
    if (!t.cols.has(col)) addColumn(t, col, v);
    const cd = t.cols.get(col);
    if (cd.oneOf && v !== null && !cd.oneOf.includes(v)) throw new PgError('23514', `new row for relation "${t.name}" violates check constraint "${t.name}_${col}_check"`);
    cols.push(col); vals.push(toDb(cd.type, v, col));
  }
  return { cols, vals };
}
function checkNotNull(t, row) {
  for (const [col, cd] of t.cols) if (cd.nn && (row[col] === null || row[col] === undefined) && !(t.identity === col && t.pk[0] === col))
    throw new PgError('23502', `null value in column "${col}" of relation "${t.name}" violates not-null constraint`);
}
function sqliteError(e, t) {
  if (e instanceof PgError) return e;
  const m = String(e.message || e);
  if (/UNIQUE constraint failed|PRIMARY KEY/i.test(m)) {
    const cols = (m.split(':')[1] || '').split(',').map(s => s.trim().split('.').pop()).filter(Boolean);
    return new PgError('23505', `duplicate key value violates unique constraint "${t.name}_${cols.join('_') || 'pkey'}_key"`, 409, `Key (${cols.join(', ')}) already exists.`);
  }
  return e;
}
const getByRowid = (t, rowid) => decodeRow(t, db.prepare(`SELECT * FROM ${q(t.name)} WHERE rowid = ?`).get(rowid));

function insertRow(t, input, me, opts = {}) {
  let row = fillDefaults(t, input, me);
  row = TRIGGERS.beforeInsert[t.name] ? TRIGGERS.beforeInsert[t.name](row, me) : row;
  if (!opts.skipCheck && !canWrite(t.name, 'insert', row, me)) throw rlsError(t.name);
  checkNotNull(t, row);
  const { cols, vals } = encodeRow(t, row);
  let res;
  try { res = db.prepare(`INSERT INTO ${q(t.name)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals); }
  catch (e) { throw sqliteError(e, t); }
  const saved = getByRowid(t, res.lastInsertRowid);
  emit(t.name, 'INSERT', saved, null);
  if (TRIGGERS.afterInsert[t.name]) TRIGGERS.afterInsert[t.name](saved, me);
  return saved;
}
function updateRow(t, rowid, old, patch, me, opts = {}) {
  let row = Object.assign({}, old, patch);
  row = TRIGGERS.beforeUpdate[t.name] ? TRIGGERS.beforeUpdate[t.name](row, old, me) : row;
  if (!opts.skipCheck && !canWrite(t.name, 'update', row, me)) throw rlsError(t.name);
  checkNotNull(t, row);
  const changed = {};
  for (const [k, v] of Object.entries(row)) if (!t.cols.has(k) || JSON.stringify(v) !== JSON.stringify(old[k])) changed[k] = v;
  if (Object.keys(changed).length) {
    const { cols, vals } = encodeRow(t, changed);
    try { db.prepare(`UPDATE ${q(t.name)} SET ${cols.map(c => q(c) + ' = ?').join(', ')} WHERE rowid = ?`).run(...vals, rowid); }
    catch (e) { throw sqliteError(e, t); }
  }
  const saved = getByRowid(t, rowid) || decodeRow(t, Object.assign({}, old, changed));
  emit(t.name, 'UPDATE', saved, old);
  if (TRIGGERS.afterUpdate[t.name]) TRIGGERS.afterUpdate[t.name](saved, old, me);
  return saved;
}
function deleteRow(t, rowid, old, me) {
  db.prepare(`DELETE FROM ${q(t.name)} WHERE rowid = ?`).run(rowid);
  emit(t.name, 'DELETE', null, old);
  if (TRIGGERS.afterDelete[t.name]) TRIGGERS.afterDelete[t.name](old, me);
  return old;
}
function matching(t, filters) {
  const params = [];
  const where = whereSql(t, filters, params);
  return db.prepare(`SELECT rowid AS __rowid, * FROM ${q(t.name)}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY rowid`).all(...params)
    .map(r => ({ rowid: r.__rowid, row: decodeRow(t, r) }));
}
// For triggers and server functions: change rows directly (with the same follow-on effects, no permission checks)
const sys = {
  insert: (tn, row) => insertRow(table(tn), row, SYSTEM, { skipCheck: true }),
  update: (tn, filters, patch) => matching(table(tn), filters).map(m => updateRow(table(tn), m.rowid, m.row, typeof patch === 'function' ? patch(m.row) : patch, SYSTEM, { skipCheck: true })),
  delete: (tn, filters) => matching(table(tn), filters).map(m => deleteRow(table(tn), m.rowid, m.row, SYSTEM)),
  one: (tn, filters) => (matching(table(tn), filters)[0] || {}).row || null,
  all: (tn, filters) => matching(table(tn), filters).map(m => m.row),
};

function transaction(fn) {
  const before = events; events = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    const done = events; events = before;
    for (const e of done) broadcast(e);
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    events = before;
    throw e;
  }
}

function runWrite(t, qr, me) {
  const rows = qr.values == null ? [] : Array.isArray(qr.values) ? qr.values : [qr.values];
  for (const r of rows) if (!r || typeof r !== 'object' || Array.isArray(r)) throw new PgError('PGRST102', 'Each row must be an object');
  return transaction(() => {
    const out = [];
    if (qr.op === 'insert') for (const r of rows) out.push(insertRow(t, r, me));
    else if (qr.op === 'upsert') {
      const keys = qr.onConflict ? String(qr.onConflict).split(',').map(s => s.trim()).filter(Boolean) : t.pk;
      for (const r of rows) {
        const missing = keys.filter(k => r[k] === undefined || r[k] === null);
        const found = missing.length ? null : matching(t, keys.map(k => [k, 'eq', r[k]]))[0];
        if (!found) { out.push(insertRow(t, r, me)); continue; }
        if (qr.ignoreDuplicates) continue;
        if (!canWrite(t.name, 'insert', fillDefaults(t, r, me), me)) throw rlsError(t.name);
        if (!canWrite(t.name, 'update', found.row, me)) throw rlsError(t.name);
        out.push(updateRow(t, found.rowid, found.row, r, me));
      }
    } else if (qr.op === 'update') {
      const patch = rows[0] || {};
      for (const m of matching(t, qr.filters)) {
        if (!canWrite(t.name, 'update', m.row, me)) continue;   // rows you can't change are left alone, as in Postgres
        out.push(updateRow(t, m.rowid, m.row, patch, me));
      }
    } else if (qr.op === 'delete') {
      for (const m of matching(t, qr.filters)) {
        if (!canWrite(t.name, 'delete', m.row, me)) continue;
        out.push(deleteRow(t, m.rowid, m.row, me));
      }
    } else throw new PgError('PGRST100', 'Unknown operation');
    return out;
  });
}

function runQuery(qr, me) {
  const t = table(String(qr.table || ''));
  if (!qr.op || qr.op === 'select') return runSelect(t, qr, me);
  const rows = runWrite(t, qr, me);
  if (!qr.returning) return { data: null, count: qr.count ? rows.length : null };
  const cols = parseSelect(t, qr.select);
  return { data: rows.map(r => project(r, cols)), count: qr.count ? rows.length : null };
}

/* =====================================================================================
   What happens automatically when rows change (the database triggers of the Supabase version)
   ===================================================================================== */
const PROFILE_DETAILS = ['job_title', 'bio', 'phone', 'contact_email', 'portal_visible'];
const TRIGGERS = {
  beforeInsert: {
    client_users: row => {
      row.email = String(row.email || '').trim().toLowerCase();
      if (!/@/.test(row.email)) throw new PgError('23514', 'new row for relation "client_users" violates check constraint "client_users_email_check"');
      return row;
    },
    client_access: row => {
      row.email = String(row.email || '').trim().toLowerCase();
      if (!sys.one('client_users', [['email', 'eq', row.email]]))
        throw new PgError('23503', 'insert or update on table "client_access" violates foreign key constraint "client_access_email_fkey"', 409, `Key (email)=(${row.email}) is not present in table "client_users".`);
      return row;
    },
    allowed_emails: row => { row.email = String(row.email || '').trim().toLowerCase(); return row; },
    site_contacts: (row, me) => siteContactBefore(row, null, me),
    // a client's file: their own name on it, and it stays a meeting file
    site_documents: (row, me) => { if (me.client && !me.approved) Object.assign(row, { uploaded_by: myName(me), uploaded_by_id: me.uid, category: 'Meetings' }); return row; },
    site_document_folders: row => {
      row.name = String(row.name || '').trim();
      if (row.name.length < 1 || row.name.length > 80) throw new PgError('23514', 'new row for relation "site_document_folders" violates check constraint "site_document_folders_name_check"');
      return row;
    },
  },
  beforeUpdate: {
    profiles: (row, old, me) => {
      if (me.system || me.admin) return row;
      if (row.approved !== old.approved || row.role !== old.role) throw new PgError('P0001', 'Only an administrator can change approval or role.');
      if (PROFILE_DETAILS.some(k => JSON.stringify(row[k]) !== JSON.stringify(old[k])) || (row.photo_path !== old.photo_path && row.id !== me.uid))
        throw new PgError('P0001', 'Only an administrator can change technician profile details.');
      return row;
    },
    site_contacts: (row, old, me) => siteContactBefore(row, old, me),
    // a visit starting or ending: the server's own time it started from (only the server sets it)
    clients: (row, old) => {
      if (!row.visit_started_at) row.visit_hold_from = null;
      else if (row.visit_started_at !== old.visit_started_at || !old.visit_started_at) row.visit_hold_from = new Date().toISOString();
      else row.visit_hold_from = old.visit_hold_from;
      return row;
    },
  },
  afterInsert: {
    clients: row => {
      const cid = String(row.id);
      const contact = String(row.Contact || '').trim();
      if (contact && !sys.one('site_contacts', [['client_id', 'eq', cid]])) {
        const sc = splitContact(contact);
        sys.insert('site_contacts', { client_id: cid, name: sc.name, phone: sc.phone, email: String(row.Email || '').trim() || null, is_primary: true });
      }
      for (const f of STANDARD_FOLDERS) if (!sys.one('site_document_folders', [['client_id', 'eq', cid], ['name', 'eq', f]]))
        sys.insert('site_document_folders', { client_id: cid, name: f, created_by: 'Pestis' });
    },
    recommendation_updates: row => applyRecUpdate(row),
    site_contacts: row => siteContactAfter(row.client_id),
    profiles: () => { accessVersion++; }, client_users: () => { accessVersion++; }, client_access: () => { accessVersion++; },
  },
  afterUpdate: {
    clients: (row, old) => { if (old.visit_hold_from && row.visit_hold_from !== old.visit_hold_from) releaseVisitHold(row.id, old.visit_hold_from); },
    site_contacts: (row, old) => { siteContactAfter(row.client_id); if (old.client_id !== row.client_id) siteContactAfter(old.client_id); },
    client_users: (row, old) => { if (row.email !== old.email) sys.update('client_access', [['email', 'eq', old.email]], { email: row.email }); accessVersion++; },
    profiles: () => { accessVersion++; }, client_access: () => { accessVersion++; },
  },
  afterDelete: {
    clients: row => { sys.delete('service_logs', [['client_id', 'eq', row.id]]); },
    site_maps: row => { sys.update('stations', [['map_id', 'eq', row.id]], { map_id: null }); },
    profiles: row => {
      sys.update('clients', [['assigned_to', 'eq', row.id]], { assigned_to: null });
      sys.update('clients', [['visit_started_by', 'eq', row.id]], { visit_started_by: null });
      accessVersion++;
    },
    client_users: row => { sys.delete('client_access', [['email', 'eq', row.email]]); accessVersion++; },
    client_access: () => { accessVersion++; },
    site_contacts: row => {
      if (row.is_primary) {
        const next = db.prepare(`SELECT id FROM site_contacts WHERE client_id = ? ORDER BY sort, created_at LIMIT 1`).get(row.client_id);
        if (next) { sys.update('site_contacts', [['id', 'eq', next.id]], { is_primary: true }); return; }
      }
      siteContactAfter(row.client_id);
    },
  },
};

let contactSwitch = false;
function siteContactBefore(row, old, me) {
  row.name = String(row.name || '').trim();
  if (row.name.length < 1 || row.name.length > 120) throw new PgError('23514', 'new row for relation "site_contacts" violates check constraint "site_contacts_name_check"');
  for (const [k, n] of [['role', 80], ['phone', 40], ['email', 160], ['notes', 500]])
    if (row[k] != null && String(row[k]).length > n) throw new PgError('23514', `new row for relation "site_contacts" violates check constraint "site_contacts_${k}_check"`);
  row.updated_at = new Date().toISOString();
  if (!me.system) row.updated_by = myName(me) || me.email || row.updated_by;
  if (!old) {
    row.created_by = row.created_by || row.updated_by;
    if (!sys.one('site_contacts', [['client_id', 'eq', row.client_id]])) row.is_primary = true;
  } else if (old.is_primary && !row.is_primary && !contactSwitch) row.is_primary = true;   // stays main until another is chosen
  if (row.is_primary) {
    contactSwitch = true;
    try { sys.update('site_contacts', [['client_id', 'eq', row.client_id], ['is_primary', 'is', true], ...(row.id ? [['id', 'neq', row.id]] : [])], { is_primary: false }); }
    finally { contactSwitch = false; }
  }
  return row;
}
function siteContactAfter(cid) {
  const m = db.prepare('SELECT name, phone FROM site_contacts WHERE client_id = ? AND is_primary = 1 LIMIT 1').get(String(cid));
  const val = m ? ((m.name || '') + (m.phone && m.phone.trim() ? ' ' + m.phone.trim() : '')).trim() || null : null;
  if (!/^\d+$/.test(String(cid))) return;
  const site = sys.one('clients', [['id', 'eq', Number(cid)]]);
  if (site && (site.Contact || null) !== val) sys.update('clients', [['id', 'eq', Number(cid)]], { Contact: val });
}
// "Jane Smith 021 123 4567" -> name "Jane Smith", phone "021 123 4567"
function splitContact(v) {
  const s = String(v || '').trim();
  const m = /(\+?\d[\d\s()-]{6,}\d)/.exec(s);
  if (!m) return { name: s, phone: null };
  const name = s.replace(m[1], '').trim().replace(/[\s,·|-]+$/, '').trim();
  return { name: name || s, phone: m[1].trim() };
}
function applyRecUpdate(u) {
  let st = u.status === 'new' ? 'open' : u.status;
  if (!['open', 'pending', 'complete'].includes(st)) st = 'pending';
  sys.update('recommendations', [['id', 'eq', u.rec_id]], { status: st, completed_at: st === 'complete' ? u.at : null, updated_at: new Date().toISOString() });
}

/* =====================================================================================
   Server functions the apps call (rpc)
   ===================================================================================== */
const fail = (msg, code = 'P0001') => { throw new PgError(code, msg); };
const prefKey = k => { if (!/^[A-Za-z0-9_]{1,40}$/.test(String(k || ''))) fail('Bad setting name'); return k; };
const clientPhoto = (cid, p) => String(p).split('/')[0] === String(cid) && /^CLIENT_/.test(String(p).split('/')[1] || '') && String(p).split('/').length === 2;

const RPC = {
  portal_whoami(me) {
    const cu = db.prepare('SELECT * FROM client_users WHERE email = ?').get(me.email);
    if (cu && cu.active) transaction(() => sys.update('client_users', [['email', 'eq', me.email]], { last_seen_at: new Date().toISOString() }));
    return { email: me.email, staff: me.approved, admin: me.admin, client: !!cu, active: !!(cu && cu.active), name: cu ? cu.full_name : null,
      company: cu ? cu.company : null, sites: db.prepare('SELECT COUNT(*) AS n FROM client_access WHERE email = ?').get(me.email).n };
  },
  portal_sites(me) {
    const all = sys.all('clients', []);
    const mine = all.filter(c => me.client ? isSiteClient(me, c.id) : me.approved);
    const hide = ['Notes', 'notes', 'safety_notes', 'access_notes', 'site_notes', 'contract_notes', 'visit_started_by', 'visit_hold_from', 'assigned_to', 'services'];
    return mine.map(c => {
      const out = Object.assign({}, c);
      for (const k of hide) delete out[k];
      let sv = c.services;
      if (typeof sv === 'string') { try { sv = JSON.parse(sv); } catch { sv = []; } }
      out.services = Array.isArray(sv) ? sv.map(s => { if (s && typeof s === 'object') { const x = Object.assign({}, s); delete x.notes; return x; } return s; }) : [];
      const p = c.assigned_to ? db.prepare('SELECT full_name, email FROM profiles WHERE id = ?').get(c.assigned_to) : null;
      out.technician = p ? (p.full_name || p.email) : null;
      return out;
    }).sort((a, b) => String(a.Name || '').toLowerCase().localeCompare(String(b.Name || '').toLowerCase()));
  },
  portal_update_recommendation(me, a) {
    const r = sys.one('recommendations', [['id', 'eq', a.p_rec_id]]);
    const isClient = me.client && !me.approved;
    if (!r || !canSeeSite(me, r.client_id) || !(isClient || me.approved)) fail('Recommendation not found');
    let st = String(a.p_status || '').trim().toLowerCase();
    if (!st) st = r.status;
    if (!['open', 'pending', 'complete'].includes(st)) fail('Status must be open, pending or complete');
    const ph = a.p_photos == null ? [] : a.p_photos;
    if (!Array.isArray(ph)) fail('Photos must be a list');
    if (ph.length > 20) fail('Up to 20 photos at a time');
    if (ph.some(p => !clientPhoto(r.client_id, p))) fail('Photo path not allowed');
    const note = String(a.p_note || '').trim();
    if (st === r.status && !note && !ph.length) fail('Nothing to save');
    if (st !== r.status && !note) fail('Add a note saying why the status is changing');
    const id = 'cu_' + crypto.randomUUID().replace(/-/g, '');
    transaction(() => sys.insert('recommendation_updates', { id, rec_id: r.id, client_id: r.client_id, status: st, note: note || null, photos: ph,
      technician: isClient ? myName(me) : (me.staffName || me.email), at: new Date().toISOString(), by_client: isClient }));
    return { id, status: st };
  },
  pestis_my_name: me => myName(me),
  pestis_mark_rec_viewed(me, a) {
    const r = sys.one('recommendations', [['id', 'eq', a.p_rec_id]]);
    const isClient = me.client && !me.approved;
    if (!r || !canSeeSite(me, r.client_id) || !(isClient || me.approved)) return null;
    transaction(() => {
      const v = sys.one('recommendation_views', [['rec_id', 'eq', r.id], ['viewer_key', 'eq', me.uid]]);
      if (v) sys.update('recommendation_views', [['rec_id', 'eq', r.id], ['viewer_key', 'eq', me.uid]], { last_seen_at: new Date().toISOString(), view_count: (v.view_count || 0) + 1, viewer_name: myName(me) });
      else sys.insert('recommendation_views', { rec_id: r.id, client_id: r.client_id, viewer_key: me.uid, viewer_name: myName(me), is_client: isClient });
      // the log of every opening (the same person opening it again within 2 minutes counts once)
      const recent = db.prepare('SELECT at FROM recommendation_view_log WHERE rec_id = ? AND viewer_key = ? ORDER BY at DESC LIMIT 1').get(r.id, me.uid);
      if (!recent || Date.now() - Date.parse(recent.at) > 120000)
        sys.insert('recommendation_view_log', { rec_id: r.id, client_id: r.client_id, viewer_key: me.uid, viewer_name: myName(me), is_client: isClient,
          app: ['Service App', 'Admin', 'Client Portal'].includes(a.p_app) ? a.p_app : (isClient ? 'Client Portal' : null) });
    });
    return null;
  },
  portal_technicians(me, a) {
    const cid = String(a.p_client_id);
    if (!canSeeSite(me, cid) || !(me.client || me.approved)) return [];
    const site = sys.one('clients', /^\d+$/.test(cid) ? [['id', 'eq', Number(cid)]] : [['id', 'eq', -1]]);
    const visits = sys.all('visits', [['client_id', 'eq', cid]]);
    return sys.all('profiles', [['approved', 'is', true], ['portal_visible', 'is', true]]).map(p => {
      const name = p.full_name || p.email;
      const mine = visits.filter(v => v.technician === name);
      return { id: p.id, name, title: p.job_title, bio: p.bio, phone: p.phone, email: p.contact_email || p.email, photo_path: p.photo_path,
        assigned: !!(site && site.assigned_to === p.id), visits: mine.length,
        last_visit: mine.reduce((m, v) => !m || (v.completed_at && v.completed_at > m) ? v.completed_at : m, null) };
    }).sort((x, y) => (y.assigned - x.assigned) || (y.visits - x.visits) || String(x.name).toLowerCase().localeCompare(String(y.name).toLowerCase()));
  },
  portal_report_sighting(me, a) {
    const cid = String(a.p_client_id || '');
    if (!canSeeSite(me, cid) || !(isSiteClient(me, cid) || me.approved)) fail('Site not found');
    if (!String(a.p_pest || '').trim()) fail('Say which pest was seen');
    if (!String(a.p_location || '').trim()) fail('Say where it was seen');
    const seen = a.p_seen_at ? new Date(a.p_seen_at) : null;
    if (!seen || isNaN(seen) || seen.getTime() > Date.now() + 3600000) fail('Enter when it was seen');
    const ph = a.p_photos == null ? [] : a.p_photos;
    if (!Array.isArray(ph) || ph.length > 10) fail('Up to 10 photos');
    if (ph.some(p => !clientPhoto(cid, p))) fail('Photo path not allowed');
    const id = crypto.randomUUID(), t = s => String(s == null ? '' : s).trim();
    let no;
    transaction(() => {
      no = (db.prepare('SELECT MAX(sighting_no) AS m FROM pest_sightings WHERE client_id = ?').get(cid).m || 0) + 1;
      sys.insert('pest_sightings', { id, client_id: cid, sighting_no: no, pest: t(a.p_pest).slice(0, 80), location: t(a.p_location).slice(0, 120),
        station_barcode: t(a.p_station) || null, seen_at: seen.toISOString(), number_seen: a.p_number == null || a.p_number === '' ? null : Math.max(0, Math.floor(Number(a.p_number)) || 0),
        evidence: t(a.p_evidence) || null, urgency: a.p_urgency === 'Urgent' ? 'Urgent' : 'Routine', reported_by: t(a.p_reported_by) || myName(me),
        reporter_contact: t(a.p_contact) || null, details: t(a.p_details) || null, photos: ph, created_by: myName(me) });
    });
    return { id, no };
  },
  portal_review_sighting(me, a) {
    const r = sys.one('pest_sightings', [['id', 'eq', a.p_id]]);
    if (!r || !canSeeSite(me, r.client_id) || !(isSiteClient(me, r.client_id) || me.approved)) fail('Sighting not found');
    if (r.status === 'new') fail('The technician has not actioned this sighting yet');
    transaction(() => sys.update('pest_sightings', [['id', 'eq', r.id]], { status: 'reviewed', client_reviewed_by: myName(me), client_reviewed_at: new Date().toISOString(),
      client_review_note: String(a.p_note || '').trim() || null, updated_at: new Date().toISOString() }));
    return null;
  },
  get_my_prefs: me => (sys.one('user_prefs', [['user_id', 'eq', me.uid]]) || {}).prefs || {},
  save_my_pref(me, a) { savePref(me.uid, a.p_key, a.p_value, 250000); return null; },
  admin_get_user_prefs(me, a) {
    if (!me.admin) fail('Only admins can do this');
    return (sys.one('user_prefs', [['user_id', 'eq', a.p_user]]) || {}).prefs || {};
  },
  admin_save_user_pref(me, a) {
    if (!me.admin) fail('Only admins can do this');
    if (!a.p_user) fail('No person given');
    savePref(a.p_user, a.p_key, a.p_value, 250000);
    return null;
  },
  pestis_idle_minutes() {
    const r = db.prepare("SELECT value FROM app_settings WHERE key = 'idle_logout_minutes'").get();
    let v = r ? fromDb('json', r.value) : null;
    if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
    return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 5;
  },
  save_my_ui_prefs(me, a) {
    prefKey(a.p_key);
    if (JSON.stringify(a.p_value ?? null).length > 20000) fail('Setting too large');
    transaction(() => sys.update('profiles', [['id', 'eq', me.uid]], p => ({ ui_prefs: Object.assign({}, p.ui_prefs || {}, { [a.p_key]: a.p_value ?? null }) })));
    return null;
  },
  pestis_is_approved: me => me.approved,
  pestis_is_admin: me => me.admin,
  pestis_is_client: me => me.client,
};
function savePref(uid, key, value, max) {
  prefKey(key);
  if (JSON.stringify(value ?? null).length > max) fail('Setting too large');
  transaction(() => {
    const ex = sys.one('user_prefs', [['user_id', 'eq', uid]]);
    if (ex) sys.update('user_prefs', [['user_id', 'eq', uid]], { prefs: Object.assign({}, ex.prefs || {}, { [key]: value ?? null }), updated_at: new Date().toISOString() });
    else sys.insert('user_prefs', { user_id: uid, prefs: { [key]: value ?? null } });
  });
}

/* =====================================================================================
   Starting data
   ===================================================================================== */
transaction(() => {
  for (const [tn, rows] of Object.entries(SEED)) if (!db.prepare(`SELECT 1 FROM ${q(tn)} LIMIT 1`).get()) for (const r of rows) sys.insert(tn, r);
  for (const e of ADMIN_EMAILS) {
    const a = sys.one('allowed_emails', [['email', 'eq', e]]);
    if (!a) sys.insert('allowed_emails', { email: e, role: 'admin', added_by: 'Server settings' });
    else if (a.role !== 'admin') sys.update('allowed_emails', [['email', 'eq', e]], { role: 'admin' });
    sys.update('profiles', [['email', 'eq', e]], { approved: true, role: 'admin' });
  }
});

// The pest list, brought in line with the pest guide (once): one "Rat" and one "Mouse", the Moths category, and the
// common New Zealand ants, flies, moths and stored product pests. The Pest found list and the pest guide both read it.
// Each existing pest goes to the first pattern it matches (the same order as the apps' PEST_LIBRARY); missing ones are added
// with just their name and category, and Admin fills in their pictures and guide.
const PEST_LIST_V = 1;
const PEST_LIST = [
  ['Rat', 'Rodents', null, /\brats?\b|norway|brown rat|sewer rat|ship rat|roof rat|black rat|rattus/i],
  ['Mouse', 'Rodents', null, /house mouse|\bmice\b|\bmouse\b|mus musculus/i],
  ['Gisborne cockroach', 'Crawling insects', 'Cockroaches', /gisborne|drymaplaneta/i],
  ['Argentine ant', 'Crawling insects', 'Ants', /argentine ant|linepithema/i],
  ['White-footed house ant', 'Crawling insects', 'Ants', /white.?footed|technomyrmex/i],
  ['Black house ant', 'Crawling insects', 'Ants', /black house ant|ochetellus/i],
  ['Coastal brown ant', 'Crawling insects', 'Ants', /coastal brown|big.?headed|pheidole/i],
  ["Darwin's ant", 'Crawling insects', 'Ants', /darwin|doleromyrma/i],
  ['Lesser house fly', 'Flying insects', 'Flies', /lesser house ?fly|fannia/i],
  ['House fly', 'Flying insects', 'Flies', /house ?fly|musca/i],
  ['Green blowfly', 'Flying insects', 'Flies', /green ?bottle|green blow ?fly|lucilia/i],
  ['Blowfly', 'Flying insects', 'Flies', /blow ?fly|bluebottle|calliphor/i],
  ['Flesh fly', 'Flying insects', 'Flies', /flesh fly|sarcophag/i],
  ['Stable fly', 'Flying insects', 'Flies', /stable fly|stomoxys/i],
  ['Fruit (vinegar) fly', 'Flying insects', 'Flies', /fruit fly|drosophila|vinegar fly/i],
  ['Drain fly', 'Flying insects', 'Flies', /drain fly|moth fly|psychod/i],
  ['Cluster fly', 'Flying insects', 'Flies', /cluster fly|pollenia/i],
  ['Fungus gnat', 'Flying insects', 'Flies', /fungus gnat|sciarid/i],
  ['Case-bearing clothes moth', 'Moths', 'Fabric moths', /case.?bearing|tinea pellionella/i],
  ['Webbing clothes moth', 'Moths', 'Fabric moths', /clothes moth|tineola|tinea/i],
  ['Brown house moth', 'Moths', 'Fabric moths', /brown house moth|hofmannophila/i],
  ['White-shouldered house moth', 'Moths', 'Fabric moths', /white.?shouldered|endrosis/i],
  ['Indian meal moth', 'Moths', 'Pantry moths', /indian ?meal ?moth|plodia/i],
  ['Mediterranean flour moth', 'Moths', 'Pantry moths', /mediterranean flour moth|ephestia kuehniella|flour moth/i],
  ['Warehouse (tobacco) moth', 'Moths', 'Pantry moths', /warehouse moth|tobacco moth|cocoa moth|ephestia elutella/i],
  ['Angoumois grain moth', 'Moths', 'Pantry moths', /angoumois|sitotroga/i],
  ['Codling moth', 'Moths', 'Garden & orchard moths', /codling|cydia/i],
  ['Light brown apple moth', 'Moths', 'Garden & orchard moths', /light brown apple|epiphyas|lbam/i],
  ['Rice weevil', 'Stored product pests', 'Beetles & weevils', /rice weevil|sitophilus oryzae/i],
  ['Maize weevil', 'Stored product pests', 'Beetles & weevils', /maize weevil|sitophilus zeamais/i],
  ['Granary weevil', 'Stored product pests', 'Beetles & weevils', /granary weevil|sitophilus granarius/i],
  ['Confused flour beetle', 'Stored product pests', 'Beetles & weevils', /confused flour beetle|tribolium confusum/i],
  ['Red flour beetle', 'Stored product pests', 'Beetles & weevils', /flour beetle|tribolium/i],
  ['Merchant grain beetle', 'Stored product pests', 'Beetles & weevils', /merchant grain|oryzaephilus mercator/i],
  ['Saw-toothed grain beetle', 'Stored product pests', 'Beetles & weevils', /saw.?toothed|oryzaephilus/i],
  ['Cigarette beetle', 'Stored product pests', 'Beetles & weevils', /cigarette beetle|lasioderma/i],
  ['Drugstore (biscuit) beetle', 'Stored product pests', 'Beetles & weevils', /drugstore beetle|stegobium|biscuit beetle/i],
  ['Lesser grain borer', 'Stored product pests', 'Beetles & weevils', /lesser grain borer|rhyzopertha/i],
  ['Flat grain beetle', 'Stored product pests', 'Beetles & weevils', /flat grain beetle|rusty grain|cryptolestes/i],
  ['Warehouse beetle', 'Stored product pests', 'Beetles & weevils', /warehouse beetle|trogoderma|khapra/i],
  ['Larder beetle', 'Stored product pests', 'Beetles & weevils', /larder beetle|dermestes|hide beetle|bacon beetle/i],
  ['Flour mite', 'Stored product pests', 'Mites & booklice', /flour mite|acarus|grain mite|cheese mite/i],
  ['Booklice (psocids)', 'Stored product pests', 'Mites & booklice', /book ?lice|booklouse|psocid/i],
];
function updatePestList() {
  const done = sys.one('app_settings', [['key', 'eq', 'pest_list_version']]);
  if (done && Number(done.value) >= PEST_LIST_V) return;
  const rows = sys.all('species', []), found = new Map();
  for (const r of rows) {
    const p = PEST_LIST.find(x => x[3].test(String(r.label || '')));
    if (p) found.set(p[0], (found.get(p[0]) || []).concat(r));
  }
  let sort = Math.max(0, ...rows.map(r => r.sort || 0));
  for (const [label, category, subcategory] of PEST_LIST) {
    const have = found.get(label) || [];
    if (!have.length) { sys.insert('species', { id: crypto.randomUUID(), label, sort: ++sort, category, subcategory }); continue; }
    if (label !== 'Rat' && label !== 'Mouse') { for (const r of have) sys.update('species', [['id', 'eq', r.id]], { category, subcategory }); continue; }
    // one rat and one mouse: keep the Norway rat / house mouse (or the first), named plainly, and remove the others
    have.sort((a, b) => /norway|house mouse/i.test(b.label) - /norway|house mouse/i.test(a.label) || (a.sort || 0) - (b.sort || 0));
    const [keep, ...extra] = have, patch = { label, category, subcategory };
    // the Rat's guide is rewritten for both rats (Admin fills it in again from the built-in guide)
    if (label === 'Rat' && keep.label !== 'Rat') Object.assign(patch, { about: null, breeding: null, control: null, gallery: null },
      /^https?:/i.test(String(keep.photo_path || '')) ? { photo_path: null, photo_source: null } : {});
    sys.update('species', [['id', 'eq', keep.id]], patch);
    for (const r of extra) sys.delete('species', [['id', 'eq', r.id]]);
  }
  if (done) sys.update('app_settings', [['key', 'eq', 'pest_list_version']], { value: PEST_LIST_V, updated_by: 'Server' });
  else sys.insert('app_settings', { key: 'pest_list_version', value: PEST_LIST_V, updated_by: 'Server' });
}
transaction(updatePestList);

// Station types renamed (once), everywhere: the list, every station, and past records. Snap Trap leaves the list
// (stations that are snap traps keep their type).
const STATION_TYPES_V = 1;
const STATION_TYPE_RENAMES = [
  ['Internal Rodent Station', 'Internal Non-Toxic Rodent Station'],
  ['External Rodent Station', 'External Non-Toxic Rodent Station'],
  ['Crawling Insect Station', 'Crawling Insect Monitoring'],
  ['Flying Insect Station (ILT)', 'Flying Insect Monitoring'],
  ['Flying Insect Station', 'Flying Insect Monitoring'],
];
function updateStationTypes() {
  const done = sys.one('app_settings', [['key', 'eq', 'station_types_version']]);
  if (done && Number(done.value) >= STATION_TYPES_V) return;
  const same = (a, b) => String(a || '').trim().toLowerCase() === b.toLowerCase();
  for (const [from, to] of STATION_TYPE_RENAMES) {
    for (const o of sys.all('station_types', [])) {
      if (!same(o.label, from)) continue;
      if (sys.all('station_types', []).some(x => same(x.label, to))) sys.delete('station_types', [['id', 'eq', o.id]]);
      else sys.update('station_types', [['id', 'eq', o.id]], { label: to });
    }
    for (const r of sys.all('stations', [])) if (same(r.type, from)) sys.update('stations', [['id', 'eq', r.id]], { type: to });
    for (const r of sys.all('recommendations', [])) if (same(r.station_type, from)) sys.update('recommendations', [['id', 'eq', r.id]], { station_type: to });
    // past station checks: the type is inside each record
    db.prepare(`UPDATE service_logs SET payload = json_set(payload, '$.deviceType', ?) WHERE lower(trim(json_extract(payload, '$.deviceType'))) = lower(?)`).run(to, from);
  }
  for (const o of sys.all('station_types', [])) if (same(o.label, 'Snap Trap')) sys.delete('station_types', [['id', 'eq', o.id]]);
  if (done) sys.update('app_settings', [['key', 'eq', 'station_types_version']], { value: STATION_TYPES_V, updated_by: 'Server' });
  else sys.insert('app_settings', { key: 'station_types_version', value: STATION_TYPES_V, updated_by: 'Server' });
}
transaction(updateStationTypes);

/* =====================================================================================
   Sign-in
   ===================================================================================== */
let certs = { keys: [], until: 0 };
async function googleKeys(force) {
  if (!force && certs.until > Date.now()) return certs.keys;
  const r = await fetch(GOOGLE_CERTS_URL);
  if (!r.ok) throw new Error('Could not fetch Google signing keys');
  const m = /max-age=(\d+)/.exec(r.headers.get('cache-control') || '');
  const j = await r.json();
  certs = { keys: j.keys || [], until: Date.now() + (m ? Number(m[1]) * 1000 : 3600000) };
  return certs.keys;
}
const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
async function verifyGoogleToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, sig] = parts;
  const header = b64json(h), claims = b64json(p);
  if (header.alg !== 'RS256') throw new Error('Unexpected token type');
  let jwk = (await googleKeys()).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'));
  if (!ok) throw new Error('Bad signature');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) throw new Error('Wrong issuer');
  if (claims.aud !== GOOGLE_CLIENT_ID) throw new Error('Token was issued for a different app');
  if (!(claims.exp > Date.now() / 1000 - 60)) throw new Error('Token expired');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('Google email not verified');
  return claims;
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
function signIn(email, info, req) {
  email = String(email).trim().toLowerCase();
  const now = new Date().toISOString();
  let u = db.prepare('SELECT * FROM auth_users WHERE email = ?').get(email);
  transaction(() => {
    if (!u) {
      db.prepare('INSERT INTO auth_users (id, email, name, avatar_url, provider, created_at, last_sign_in_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(crypto.randomUUID(), email, info.name || null, info.picture || null, info.provider, now, now);
    } else {
      db.prepare('UPDATE auth_users SET name = COALESCE(?, name), avatar_url = COALESCE(?, avatar_url), provider = ?, last_sign_in_at = ? WHERE id = ?')
        .run(info.name || null, info.picture || null, info.provider, now, u.id);
    }
    u = db.prepare('SELECT * FROM auth_users WHERE email = ?').get(email);
    // a staff profile for everyone who signs in (approved straight away if an admin added the email beforehand)
    const prof = sys.one('profiles', [['id', 'eq', u.id]]);
    const allowed = sys.one('allowed_emails', [['email', 'eq', email]]);
    const forcedAdmin = ADMIN_EMAILS.includes(email);
    if (!prof) {
      sys.insert('profiles', { id: u.id, email, full_name: info.name || email.split('@')[0], avatar_url: info.picture || null,
        approved: !!allowed || forcedAdmin, role: forcedAdmin ? 'admin' : (allowed ? allowed.role : 'technician') });
    } else {
      const patch = {};
      if (!prof.avatar_url && info.picture) patch.avatar_url = info.picture;
      if (forcedAdmin && (!prof.approved || prof.role !== 'admin')) Object.assign(patch, { approved: true, role: 'admin' });
      if (Object.keys(patch).length) sys.update('profiles', [['id', 'eq', u.id]], patch);
    }
  });
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, created, expires, agent) VALUES (?, ?, ?, ?, ?)')
    .run(sha(token), u.id, Date.now(), Date.now() + SESSION_MS, String(req.headers['user-agent'] || '').slice(0, 200));
  return sessionJson(token, u);
}
function userJson(u) {
  return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: u.created_at, phone: '',
    app_metadata: { provider: u.provider || 'email', providers: [u.provider || 'email'] },
    user_metadata: { email: u.email, email_verified: true, full_name: u.name || null, name: u.name || null, avatar_url: u.avatar_url || null, picture: u.avatar_url || null },
    created_at: u.created_at, last_sign_in_at: u.last_sign_in_at };
}
function sessionJson(token, u) {
  const expiresIn = Math.floor(SESSION_MS / 1000);
  return { access_token: token, refresh_token: token, token_type: 'bearer', expires_in: expiresIn, expires_at: Math.floor(Date.now() / 1000) + expiresIn, user: userJson(u) };
}
function sessionUser(req, tokenOverride) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  const tok = tokenOverride || (m && m[1]);
  if (!tok) return null;
  const h = sha(tok), s = db.prepare('SELECT * FROM auth_sessions WHERE token_hash = ?').get(h);
  if (!s) return null;
  if (s.expires < Date.now()) { db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(h); return null; }
  if (s.expires - Date.now() < SESSION_MS - 3600000) db.prepare('UPDATE auth_sessions SET expires = ? WHERE token_hash = ?').run(Date.now() + SESSION_MS, h);   // used: renewed
  const me = ctxFor(s.user_id);
  if (!me) return null;
  me.tokenHash = h;
  return me;
}
setInterval(() => {
  db.prepare('DELETE FROM auth_sessions WHERE expires < ?').run(Date.now());
  db.prepare('DELETE FROM auth_links WHERE expires < ?').run(Date.now() - 86400000);
}, 3600000).unref();

const attempts = new Map();   // ip/email -> {n, until}: slows down repeated tries
function limited(key, max, windowMs) {
  const now = Date.now(), a = attempts.get(key);
  if (!a || a.until < now) { attempts.set(key, { n: 1, until: now + windowMs }); return false; }
  a.n++;
  return a.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of attempts) if (a.until < now) attempts.delete(k); }, 600000).unref();

function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
function safeRedirect(req, to) {
  try { const u = new URL(String(to || '/'), originOf(req)); if (u.origin === originOf(req)) return u.pathname + u.search + u.hash; } catch {}
  return '/';
}

async function handleAuth(req, res, sub, ip) {
  if (sub === 'config' && req.method === 'GET') return json(res, 200, { google: GOOGLE_CLIENT_ID || null, email: MAIL_ON });
  if (sub === 'google' && req.method === 'POST') {
    if (!GOOGLE_CLIENT_ID) return json(res, 400, { error: 'Google sign-in is not set up on this server yet (GOOGLE_CLIENT_ID).' });
    if (limited('g:' + ip, 20, 600000)) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const body = await readJson(req, 64 * 1024);
    let claims;
    try { claims = await verifyGoogleToken(body.credential); }
    catch (e) { return json(res, 401, { error: 'Google sign-in could not be checked: ' + e.message }); }
    if (body.nonce && claims.nonce && claims.nonce !== body.nonce) return json(res, 401, { error: 'Google sign-in could not be checked: the sign-in was started somewhere else. Try again.' });
    attempts.delete('g:' + ip);
    return json(res, 200, { session: signIn(claims.email, { name: claims.name, picture: claims.picture, provider: 'google' }, req) });
  }
  if (sub === 'magic' && req.method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'Enter a valid email address' });
    if (!MAIL_ON) return json(res, 400, { error: "Email sign-in links aren't set up on this server. Sign in with Google instead." });
    if (limited('m:' + ip, 10, 3600000) || limited('e:' + email, 3, 600000)) return json(res, 429, { error: 'Too many sign-in emails. Wait a few minutes and try again.' });
    // only people the business knows about get an email (a client login, staff, or an approved email); everyone else gets the same answer
    const known = db.prepare('SELECT 1 FROM client_users WHERE email = ? AND active = 1').get(email) || db.prepare('SELECT 1 FROM profiles WHERE email = ?').get(email)
      || db.prepare('SELECT 1 FROM allowed_emails WHERE email = ?').get(email) || ADMIN_EMAILS.includes(email);
    if (known) {
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('INSERT INTO auth_links (token_hash, email, redirect_to, expires) VALUES (?, ?, ?, ?)').run(sha(token), email, safeRedirect(req, body.redirectTo), Date.now() + 3600000);
      const link = `${originOf(req)}/auth/callback?link=${token}`;
      try {
        await sendMail(Object.assign({}, SMTP, { to: email, subject: 'Your Pestis sign-in link',
          text: `Use this link to sign in to the Pestis Client Portal:\n\n${link}\n\nThe link works once and expires in an hour. If you didn't ask for it, you can ignore this email.`,
          html: `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#111">
<p>Use this button to sign in to the Pestis Client Portal:</p>
<p><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Sign in to Pestis</a></p>
<p style="color:#555;font-size:13px">The link works once and expires in an hour. If you didn't ask for it, you can ignore this email.</p></div>` }));
      } catch (e) {
        console.error('Sign-in email failed:', e.message);
        return json(res, 502, { error: 'The sign-in email could not be sent: ' + e.message });
      }
    } else console.log(`Sign-in link asked for an unknown email (${email}); none sent`);
    return json(res, 200, { ok: true });
  }
  if (sub === 'verify' && req.method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    if (limited('v:' + ip, 30, 600000)) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const h = sha(body.token || ''), l = db.prepare('SELECT * FROM auth_links WHERE token_hash = ?').get(h);
    if (!l || l.used || l.expires < Date.now()) return json(res, 401, { error: 'This sign-in link has expired or has already been used. Ask for a new one.' });
    db.prepare('UPDATE auth_links SET used = 1 WHERE token_hash = ?').run(h);
    return json(res, 200, { session: signIn(l.email, { provider: 'email' }, req), redirectTo: l.redirect_to || '/' });
  }
  const me = sessionUser(req);
  if (sub === 'user' && req.method === 'GET') return me ? json(res, 200, { user: userJson(me.user) }) : json(res, 401, { error: 'Not signed in', code: 'session_not_found' });
  if (sub === 'logout' && req.method === 'POST') {
    const body = await readJson(req, 4096).catch(() => ({}));
    if (me) {
      if (body.scope === 'global') db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(me.uid);
      else db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(me.tokenHash);
    }
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Unknown path' });
}

/* =====================================================================================
   Files (photos, floor plans, documents)
   ===================================================================================== */
function cleanPath(p) {
  const s = String(p || '').replace(/^\/+/, '');
  if (!s || s.length > 900 || /\\|\0/.test(s) || s.split('/').some(x => x === '' || x === '.' || x === '..')) throw new PgError('InvalidKey', 'Invalid file name: ' + s.slice(0, 80), 400);
  return s;
}
const fileSite = p => { const a = p.split('/'); return a[0] === 'site-covers' ? a[1] : a[0]; };
function clientCanReadFile(me, bucket, p) {
  if (!me.client) return false;
  const a = p.split('/');
  return canSeeSite(me, fileSite(p)) || (bucket === 'station-photos' && a[0] === 'staff' && !!a[2]) || (a[0] === 'library' && ['sds', 'pests'].includes(a[1]) && !!a[2]);
}
// a client's own file in their site's Meetings folder: <site>/CLIENT_MEETING_<name>
const clientMeetingFile = (me, p) => { const a = p.split('/'); return me.client && a.length === 2 && /^CLIENT_MEETING_/.test(a[1]) && isSiteClient(me, a[0]); };
const fileOwner = (bucket, p) => (db.prepare('SELECT owner FROM storage_objects WHERE bucket = ? AND name = ?').get(bucket, p) || {}).owner;
function fileAllowed(me, bucket, p, op) {
  if (!BUCKETS[bucket]) return false;
  if (op === 'read') return me.approved || clientCanReadFile(me, bucket, p);
  if (bucket === 'site-documents') return me.admin || (clientMeetingFile(me, p) && (op === 'insert' || fileOwner(bucket, p) === me.uid));
  if (op === 'insert') { const a = p.split('/'); return me.approved || (me.client && a.length === 2 && /^CLIENT_/.test(a[1]) && canSeeSite(me, a[0])); }
  return me.approved;   // replace, delete
}
const diskPath = (bucket, p) => path.join(FILES_DIR, bucket, ...p.split('/'));
function signFile(req, bucket, p, seconds) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(10, Math.min(Number(seconds) || 3600, 7 * 86400));
  const sig = crypto.createHmac('sha256', SECRET).update(`${bucket}/${p}:${exp}`).digest('base64url');
  return `${originOf(req)}/api/files/${encodeURIComponent(bucket)}/${p.split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${sig}`;
}
const storageErr = (res, status, message, error = 'Error') => json(res, status, { statusCode: String(status), error, message });

async function handleStorage(req, res, parts, url, me) {
  const [action, bucket] = parts;
  if (!BUCKETS[bucket]) return storageErr(res, 404, 'Bucket not found', 'Not Found');
  if (action === 'upload' && req.method === 'POST') {
    const p = cleanPath(parts.slice(2).join('/'));
    const upsert = /^true$/i.test(String(req.headers['x-upsert'] || ''));
    const exists = db.prepare('SELECT 1 FROM storage_objects WHERE bucket = ? AND name = ?').get(bucket, p);
    if (exists && !upsert) { req.resume(); return storageErr(res, 409, 'The resource already exists', 'Duplicate'); }
    if (!fileAllowed(me, bucket, p, exists ? 'update' : 'insert')) { req.resume(); return storageErr(res, 403, 'new row violates row-level security policy', 'Unauthorized'); }
    const max = BUCKETS[bucket].maxBytes;
    if (Number(req.headers['content-length'] || 0) > max) { req.resume(); return storageErr(res, 413, 'The object exceeded the maximum allowed size', 'Payload too large'); }
    const file = diskPath(bucket, p), tmp = file + '.part-' + crypto.randomBytes(4).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.on('data', ch => { size += ch.length; if (size > max) { req.destroy(); out.destroy(); reject(Object.assign(new Error('too large'), { status: 413 })); } });
      req.on('error', reject); out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    }).catch(e => { try { fs.unlinkSync(tmp); } catch {} throw e; });
    fs.renameSync(tmp, file);
    const now = new Date().toISOString(), mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].slice(0, 100);
    db.prepare(`INSERT INTO storage_objects (bucket, name, mime, size, owner, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (bucket, name) DO UPDATE SET mime = excluded.mime, size = excluded.size, updated_at = excluded.updated_at`).run(bucket, p, mime, size, me.uid, now, now);
    return json(res, 200, { Key: `${bucket}/${p}`, path: p, id: sha(bucket + '/' + p).slice(0, 32) });
  }
  if (action === 'sign' && req.method === 'POST') {
    const body = await readJson(req, 2 * 1024 * 1024);
    const list = Array.isArray(body.paths) ? body.paths : [body.path];
    const out = list.map(raw => {
      let p;
      try { p = cleanPath(raw); } catch { return { path: raw, signedURL: null, signedUrl: null, error: 'Invalid file name' }; }
      if (!fileAllowed(me, bucket, p, 'read')) return { path: p, signedURL: null, signedUrl: null, error: 'Object not found' };
      if (!db.prepare('SELECT 1 FROM storage_objects WHERE bucket = ? AND name = ?').get(bucket, p)) return { path: p, signedURL: null, signedUrl: null, error: 'Object not found' };
      const u = signFile(req, bucket, p, body.expiresIn);
      return { path: p, signedURL: u, signedUrl: u, error: null };
    });
    if (!Array.isArray(body.paths)) { const o = out[0]; return o.error ? storageErr(res, 400, o.error, 'not_found') : json(res, 200, { signedURL: o.signedURL, signedUrl: o.signedUrl }); }
    return json(res, 200, out);
  }
  if (action === 'remove' && req.method === 'POST') {
    const body = await readJson(req, 2 * 1024 * 1024);
    const removed = [];
    for (const raw of Array.isArray(body.paths) ? body.paths : []) {
      let p; try { p = cleanPath(raw); } catch { continue; }
      if (!fileAllowed(me, bucket, p, 'delete')) continue;
      const o = db.prepare('SELECT * FROM storage_objects WHERE bucket = ? AND name = ?').get(bucket, p);
      if (!o) continue;
      try { fs.unlinkSync(diskPath(bucket, p)); } catch {}
      db.prepare('DELETE FROM storage_objects WHERE bucket = ? AND name = ?').run(bucket, p);
      removed.push({ name: p, bucket_id: bucket });
    }
    return json(res, 200, removed);
  }
  return storageErr(res, 404, 'Unknown storage request', 'Not Found');
}

function serveFile(req, res, parts, url) {
  const bucket = parts[0];
  let p;
  try { p = cleanPath(parts.slice(1).join('/')); } catch { return send(res, 400, 'Bad file name', 'text/plain'); }
  const exp = Number(url.searchParams.get('exp')), sig = String(url.searchParams.get('sig') || '');
  const good = crypto.createHmac('sha256', SECRET).update(`${bucket}/${p}:${exp}`).digest('base64url');
  if (!BUCKETS[bucket] || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return send(res, 403, 'This link is not valid', 'text/plain');
  if (!(exp > Date.now() / 1000)) return send(res, 403, 'This link has expired', 'text/plain');
  const o = db.prepare('SELECT * FROM storage_objects WHERE bucket = ? AND name = ?').get(bucket, p);
  const file = diskPath(bucket, p);
  let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'Not found', 'text/plain'); }
  const headers = { 'Content-Type': (o && o.mime) || 'application/octet-stream', 'Accept-Ranges': 'bytes',
    'Cache-Control': `private, max-age=${Math.max(0, Math.floor(exp - Date.now() / 1000))}`, 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(p.split('/').pop())}` };
  if (/^text\/html|svg/i.test(headers['Content-Type'])) headers['Content-Security-Policy'] = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]), end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start); end = Math.min(st.size - 1, end);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, Object.assign(headers, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 }));
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, Object.assign(headers, { 'Content-Length': st.size }));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

/* =====================================================================================
   Live updates (server-sent events)
   ===================================================================================== */
const listeners = new Map();   // id -> { res, uid, tokenHash, me }
function broadcast(e) {
  if (!listeners.size) return;
  const at = new Date().toISOString();
  for (const [id, l] of listeners) {
    try {
      if (l.me.version !== accessVersion) { const fresh = ctxFor(l.uid); if (!fresh) { l.res.end(); listeners.delete(id); continue; } l.me = fresh; }
      const row = e.row || e.old;
      if (e.clientsOnly && l.me.approved) continue;   // released after a visit: staff already have these
      if (!canRead(e.table, row, l.me)) continue;
      l.res.write(`data: ${JSON.stringify({ schema: 'public', table: e.table, eventType: e.type, commit_timestamp: at, new: e.row || {}, old: e.old || {}, errors: null })}\n\n`);
    } catch {}
  }
}
setInterval(() => {
  for (const [id, l] of listeners) {
    const s = db.prepare('SELECT expires FROM auth_sessions WHERE token_hash = ?').get(l.tokenHash);
    if (!s || s.expires < Date.now()) { try { l.res.write('event: signed-out\ndata: {}\n\n'); l.res.end(); } catch {} listeners.delete(id); continue; }
    try { l.res.write(': ping\n\n'); } catch {}
  }
}, 25000).unref();

/* =====================================================================================
   PostgREST-style reads (GET /rest/v1/<table>?select=...&col=eq.value&order=col.asc&limit=..&offset=..)
   ===================================================================================== */
function restQuery(tableName, sp) {
  const qr = { table: tableName, op: 'select', select: sp.get('select') || '*', filters: [], order: [] };
  for (const [k, v] of sp) {
    if (k === 'select') continue;
    if (k === 'limit') { qr.limit = Number(v); continue; }
    if (k === 'offset') { qr.offset = Number(v); continue; }
    if (k === 'order') { for (const o of v.split(',')) { const [col, dir, nulls] = o.split('.'); qr.order.push([col, dir !== 'desc', nulls ? nulls === 'nullsfirst' : undefined]); } continue; }
    const m = /^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.*)$/s.exec(v);
    if (!m) throw new PgError('PGRST100', `Bad filter for ${k}`);
    let val = m[3];
    if (m[2] === 'in') val = val.replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"(.*)"$/, '$1'));
    qr.filters.push(m[1] ? [k, 'not', m[2], val] : [k, m[2], val]);
  }
  return qr;
}

/* =====================================================================================
   HTTP
   ===================================================================================== */
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, extra));
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj));
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function readJson(req, limit = MAX_JSON) {
  const text = await readBody(req, limit);
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Body must be JSON'), { status: 400 }); }
}
const pgErrJson = e => ({ message: e.message, code: e.code || '', details: e.details || null, hint: e.hint || null });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch { return send(res, 400, 'Bad path', 'text/plain'); }
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/admin' || p === '/client' || p === '/portal') p = p === '/admin' ? '/admin.html' : '/client.html';
  // only the apps (top-level files) and their pictures are public: never the server, sources, tools or tests
  const parts = p.split('/').filter(Boolean);
  if (!parts.length || parts.some(x => x.startsWith('.')) || (parts.length > 1 && parts[0] !== 'images') || !MIME[path.extname(p).toLowerCase()])
    return send(res, 404, 'Not found', 'text/plain');
  const file = path.resolve(PUBLIC_DIR, '.' + p);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const CALLBACK_HTML = fs.readFileSync(path.join(HERE, 'callback.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const pn = url.pathname;

    if (pn === '/auth/callback') return send(res, 200, CALLBACK_HTML, 'text/html; charset=utf-8', { 'Referrer-Policy': 'no-referrer' });
    if (pn === '/auth/v1/health' || pn === '/api/health') return json(res, 200, { ok: true, app: 'pestis', google: !!GOOGLE_CLIENT_ID, email: MAIL_ON });
    if (pn.startsWith('/api/auth/')) return await handleAuth(req, res, pn.slice(10), ip);
    if (pn.startsWith('/api/files/') && (req.method === 'GET' || req.method === 'HEAD')) return serveFile(req, res, pn.slice(11).split('/').map(decodeURIComponent), url);

    if (pn.startsWith('/api/') || pn.startsWith('/rest/v1/')) {
      const me = sessionUser(req);
      if (!me) return json(res, 401, { message: 'Not signed in (or the sign-in has ended). Sign in again.', code: 'session_not_found' });

      if (pn === '/api/db' && req.method === 'POST') {
        const qr = await readJson(req);
        try { return json(res, 200, runQuery(qr, me)); }
        catch (e) { if (!(e instanceof PgError)) throw e; return json(res, e.status || 400, { error: pgErrJson(e) }); }
      }
      if (pn.startsWith('/api/rpc/') && req.method === 'POST') {
        const name = pn.slice(9), fn = Object.prototype.hasOwnProperty.call(RPC, name) ? RPC[name] : null;
        const args = await readJson(req);
        if (!fn) return json(res, 404, { error: { code: 'PGRST202', message: `Could not find the function public.${name} without parameters in the schema cache`, details: null, hint: null } });
        try { const out = fn(me, args || {}); return json(res, 200, { data: out === undefined ? null : out }); }
        catch (e) { if (!(e instanceof PgError)) throw e; return json(res, e.status || 400, { error: pgErrJson(e) }); }
      }
      if (pn.startsWith('/rest/v1/') && req.method === 'GET') {
        try { return json(res, 200, runQuery(restQuery(decodeURIComponent(pn.slice(9)), url.searchParams), me).data); }
        catch (e) { if (!(e instanceof PgError)) throw e; return json(res, e.status || 400, pgErrJson(e)); }
      }
      if (pn.startsWith('/api/storage/')) {
        try { return await handleStorage(req, res, pn.slice(13).split('/').map(decodeURIComponent), url, me); }
        catch (e) { if (e instanceof PgError) return storageErr(res, e.status || 400, e.message); throw e; }
      }
      if (pn === '/api/live' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
        const id = crypto.randomBytes(8).toString('hex');
        listeners.set(id, { res, uid: me.uid, tokenHash: me.tokenHash, me });
        res.write(`event: ready\ndata: {}\n\n`);
        req.on('close', () => listeners.delete(id));
        return;
      }
      return json(res, 404, { message: 'Unknown path' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    return serveStatic(req, res, pn);
  } catch (e) {
    const code = e.status || 500;
    if (code === 500) console.error(e);
    if (!res.headersSent) json(res, code, { message: code === 413 ? 'Too large' : code === 400 ? e.message : 'Server error', error: code === 500 ? 'Server error: ' + e.message : e.message });
    else try { res.end(); } catch {}
  }
});
server.requestTimeout = 0;   // big uploads on slow connections
server.headersTimeout = 60000;

server.listen(PORT, HOST, () => console.log(`Pestis server on http://${HOST}:${PORT} (database ${DB_PATH}); Google sign-in ${GOOGLE_CLIENT_ID ? 'ON' : 'OFF (set GOOGLE_CLIENT_ID)'}; email links ${MAIL_ON ? 'ON' : 'off'}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); try { db.close(); } catch {} process.exit(0); });
