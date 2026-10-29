// API tests: the real pestis-db.js (as the apps use it) against the real server.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { start, idToken, mails, ROOT, tmpDir } from './harness.mjs';

const PORT = 8093, BASE = `http://127.0.0.1:${PORT}`;
const srv = await start({ port: PORT, dataDir: tmpDir('api') });

// a browser-ish global for the shim
const store = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k), key: i => [...store.keys()][i], get length() { return store.size; } };
globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.location = { origin: BASE, href: BASE + '/', assign: u => { globalThis.lastAssign = u; } };
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'pestis-db.js'), 'utf8'));

let fails = 0, passes = 0;
const ok = (cond, msg, extra) => { if (cond) passes++; else { fails++; console.log('FAIL:', msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } };

async function as(email) {
  const r = await fetch(BASE + '/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: idToken(email) }) });
  const j = await r.json();
  if (!j.session) throw new Error('sign-in failed for ' + email + ': ' + JSON.stringify(j));
  const key = 'sb-' + email + '-auth-token';
  store.set(key, JSON.stringify(j.session));
  const c = window.supabase.createClient(BASE, 'x', { auth: { storageKey: key } });
  c.uid = j.session.user.id;
  return c;
}

try {
  // ---------- sign-in ----------
  const bad = await fetch(BASE + '/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: idToken('x@example.com', { aud: 'other' }) }) });
  ok(bad.status === 401, 'token for another app refused');
  const boss = await as('boss@example.com');
  let r = await boss.from('profiles').select('*').eq('id', boss.uid).maybeSingle();
  ok(r.data && r.data.approved && r.data.role === 'admin', 'ADMIN_EMAILS person is an approved admin', r);

  // admin pre-approves a technician
  r = await boss.from('allowed_emails').upsert({ email: 'tech@example.com', role: 'technician' });
  ok(!r.error, 'admin adds allowed email', r.error);
  const tech = await as('tech@example.com');
  r = await tech.from('profiles').select('*').eq('id', tech.uid).maybeSingle();
  ok(r.data && r.data.approved === true && r.data.role === 'technician', 'pre-approved technician is approved at first sign-in', r.data);
  const stranger = await as('nobody@example.com');
  r = await stranger.from('profiles').select('*').eq('id', stranger.uid).maybeSingle();
  ok(r.data && r.data.approved === false, 'unknown person gets an unapproved profile', r.data);
  r = await stranger.from('clients').select('*');
  ok(Array.isArray(r.data) && r.data.length === 0 && !r.error, 'unapproved person sees no sites', r);
  r = await stranger.from('clients').insert({ Name: 'Hack' });
  ok(r.error && r.error.code === '42501', 'unapproved person cannot add a site', r.error);
  r = await stranger.from('profiles').update({ approved: true }).eq('id', stranger.uid);
  ok(r.error && /administrator/.test(r.error.message), 'cannot approve yourself', r.error);
  r = await stranger.from('profiles').update({ full_name: 'Nob' }).eq('id', stranger.uid).select('full_name');
  ok(!r.error && r.data[0].full_name === 'Nob', 'can change own name', r);

  // ---------- sites ----------
  r = await tech.from('clients').insert([{ Name: 'Acme Foods', Address: '1 Main St', Contact: 'Jane Smith 021 123 4567', Email: 'jane@acme.test', Notes: 'Gate code 1234', services: [{ name: 'Rodent', notes: 'secret' }] }]).select('*');
  ok(!r.error && r.data[0].id === 1, 'technician adds a site (id 1)', r);
  const site = r.data[0];
  r = await tech.from('clients').insert([{ Name: 'Beta Ltd', Contact: 'Bob' }]).select('id').single();
  ok(!r.error && r.data.id === 2, 'second site id 2 (single)', r);
  r = await tech.from('site_contacts').select('*').eq('client_id', '1');
  ok(r.data && r.data.length === 1 && r.data[0].name === 'Jane Smith' && r.data[0].phone === '021 123 4567' && r.data[0].is_primary === true, 'site contact made from Contact', r.data);
  r = await tech.from('site_document_folders').select('name').eq('client_id', '1');
  ok(r.data && r.data.length === 8, 'standard folders made', r.data);
  // new main contact syncs back to the site
  r = await tech.from('site_contacts').insert([{ id: 'sc2', client_id: '1', name: 'Pat Lee', phone: '022 555 0000', role: 'Manager', is_primary: true }]).select('*');
  ok(!r.error && r.data[0].updated_by === 'tech', 'add contact; updated_by is the name', r);
  r = await tech.from('clients').select('Contact').eq('id', 1).single();
  ok(r.data && r.data.Contact === 'Pat Lee 022 555 0000', 'main contact copied to the site', r.data);
  r = await tech.from('site_contacts').select('id, is_primary').eq('client_id', '1').order('created_at');
  ok(r.data.filter(x => x.is_primary).length === 1 && r.data.find(x => x.id === 'sc2').is_primary, 'only one main contact', r.data);
  await tech.from('site_contacts').delete().eq('id', 'sc2');
  r = await tech.from('clients').select('Contact').eq('id', 1).single();
  ok(r.data.Contact === 'Jane Smith 021 123 4567', 'removing the main contact makes the next one main', r.data);

  // ---------- records ----------
  const logs = [];
  for (let i = 0; i < 5; i++) logs.push({ client_id: 1, barcode_id: 'B' + i, payload: { clientRef: 'ref' + i, activity: i } });
  r = await tech.from('service_logs').insert(logs).select('id, payload, created_at, technician_id');
  ok(!r.error && r.data.length === 5 && r.data[0].technician_id === tech.uid && r.data[0].payload.clientRef === 'ref0', 'insert records; technician_id defaulted', r);
  r = await tech.from('service_logs').select('barcode_id').eq('client_id', 1).eq('payload->>clientRef', 'ref3').limit(1);
  ok(r.data && r.data.length === 1 && r.data[0].barcode_id === 'B3', 'json path filter', r);
  r = await tech.from('service_logs').select('barcode_id', { count: 'exact', head: true }).eq('client_id', '1');
  ok(r.count === 5 && r.data === null, 'count head (string id for int column)', r);
  r = await tech.from('service_logs').select('payload').eq('client_id', 1).in('payload->>clientRef', ['ref1', 'ref2']);
  ok(r.data && r.data.length === 2, 'in on json path', r);
  r = await tech.from('service_logs').delete().eq('client_id', 1).in('payload->>clientRef', ['ref4']).select('barcode_id');
  ok(r.data && r.data.length === 1 && r.data[0].barcode_id === 'B4', 'delete returning', r);
  r = await tech.from('service_logs').select('barcode_id').eq('client_id', 1).is('payload->>missing', null).order('barcode_id', { ascending: false }).range(0, 1);
  ok(r.data && r.data.map(x => x.barcode_id).join() === 'B3,B2', 'is null + order desc + range', r);
  r = await tech.from('service_logs').select('nope');
  ok(r.error && r.error.code === '42703', 'unknown column errors', r.error);
  r = await tech.from('app_options').select('*');
  ok(r.error && /could not find the table/i.test(r.error.message), 'unknown table errors like Supabase', r.error);
  // the one direct REST call the Service App makes
  const tok = JSON.parse(store.get('sb-tech@example.com-auth-token')).access_token;
  const rest = await fetch(`${BASE}/rest/v1/service_logs?select=barcode_id,payload,created_at&client_id=eq.1&order=created_at.asc&limit=2&offset=1`, { headers: { Authorization: 'Bearer ' + tok } });
  const rj = await rest.json();
  ok(rest.ok && rj.length === 2 && rj[0].barcode_id === 'B1', 'REST read with limit/offset', rj);

  // recommendations
  r = await tech.from('recommendations').upsert([{ id: 'rec-a', client_id: '1', text: 'Seal gap', photos: ['1/a.jpg'] }], { onConflict: 'id' }).select('*');
  ok(!r.error && r.data[0].rec_no === 1 && r.data[0].status === 'open', 'recommendation numbered R1', r);
  r = await tech.from('recommendations').upsert([{ id: 'rec-b', client_id: '2', text: 'Other site' }], { onConflict: 'id' }).select('rec_no');
  ok(r.data[0].rec_no === 2, 'R2', r);
  r = await tech.from('recommendations').upsert([{ id: 'rec-a', client_id: '1', text: 'Seal gap (edited)' }], { onConflict: 'id' }).select('*');
  ok(r.data[0].rec_no === 1 && r.data[0].text === 'Seal gap (edited)', 're-saving keeps the number', r.data);
  r = await tech.from('recommendations').insert([{ id: 'rec-c', client_id: '1', text: 'x', status: 'bogus' }]);
  ok(r.error && r.error.code === '23514', 'status must be open/pending/complete', r.error);
  r = await tech.from('recommendation_updates').insert([{ id: 'u1', rec_id: 'rec-a', client_id: '1', status: 'complete', note: 'Done', at: '2026-10-01T10:00:00Z' }]);
  ok(!r.error, 'add rec update', r.error);
  r = await tech.from('recommendations').select('status, completed_at').eq('id', 'rec-a').single();
  ok(r.data.status === 'complete' && r.data.completed_at === '2026-10-01T10:00:00.000Z', 'rec update sets status', r.data);
  // stations: unique barcode per site
  r = await tech.from('stations').insert([{ id: 's1', client_id: '1', barcode: 'B1', name: 'Front door' }]);
  ok(!r.error, 'add station', r.error);
  r = await tech.from('stations').insert([{ id: 's2', client_id: '1', barcode: 'B1', name: 'Dup' }]);
  ok(r.error && r.error.code === '23505', 'duplicate barcode refused', r.error);
  r = await tech.from('site_maps').insert([{ id: 'm1', client_id: '1', name: 'Ground', drawing: { walls: [] } }]);
  await tech.from('stations').update({ map_id: 'm1', pin_x: 0.5, pin_y: 0.25 }).eq('id', 's1');
  await tech.from('site_maps').delete().eq('id', 'm1');
  r = await tech.from('stations').select('map_id, pin_x').eq('id', 's1').single();
  ok(r.data.map_id === null && r.data.pin_x === 0.5, 'deleting a plan unpins its stations', r.data);
  // the pest list matches the pest guide: one Rat and Mouse, and the common NZ pests in their categories
  r = await tech.from('species').select('*');
  const sp = r.data || [], spIn = c => sp.filter(x => x.category === c).map(x => x.label);
  ok(sp.some(x => x.label === 'Rat') && sp.some(x => x.label === 'Mouse') && !sp.some(x => /norway|ship rat|house mouse/i.test(x.label)), 'one Rat and Mouse; the Norway/ship rats and house mouse merged', sp.map(x => x.label));
  ok(sp.filter(x => x.label === 'Rat').length === 1 && sp.find(x => x.label === 'Rat').category === 'Rodents', 'Rat is a rodent');
  ok(sp.some(x => x.label === 'Gisborne cockroach' && x.subcategory === 'Cockroaches'), 'Gisborne cockroach added');
  ok(['Argentine ant', "Darwin's ant", 'White-footed house ant', 'Black house ant', 'Coastal brown ant'].every(l => sp.some(x => x.label === l && x.subcategory === 'Ants')), 'the five common ants', sp.filter(x => x.subcategory === 'Ants').map(x => x.label));
  ok(sp.filter(x => x.subcategory === 'Flies').length === 10, 'ten flies', sp.filter(x => x.subcategory === 'Flies').map(x => x.label));
  ok(spIn('Moths').length === 10, 'Moths category with ten moths', spIn('Moths'));
  ok(spIn('Stored product pests').length === 15, 'fifteen stored product pests', spIn('Stored product pests'));
  ok(new Set(sp.map(x => x.label.toLowerCase())).size === sp.length, 'no pest twice');
  r = await tech.from('app_settings').select('*').eq('key', 'pest_list_version').maybeSingle();
  ok(r.data && Number(r.data.value) === 1, 'the pest list update is recorded (so it only runs once)', r);
  // lists: admin only
  r = await tech.from('species').insert({ id: 'sp-x', label: 'Wasp' });
  ok(r.error && r.error.code === '42501', 'technician cannot change lists', r.error);
  r = await boss.from('species').insert({ id: 'sp-x', label: 'Wasp', sort: 99 }).select();
  ok(!r.error && r.data[0].label === 'Wasp', 'admin can', r.error);
  r = await tech.from('station_types').select('*').order('sort', { ascending: true });
  ok(r.data.length === 8 && r.data[0].label === 'External Non-Toxic Rodent Station' && r.data.some(x => x.label === 'Flying Insect Monitoring') && !r.data.some(x => /snap trap/i.test(x.label)), 'starting station types (renamed, no Snap Trap)', r.data && r.data.map(x => x.label));
  // unknown column on save is added
  r = await tech.from('clients').update({ safety_notes: 'Hard hats' }).eq('id', 1).select('safety_notes');
  ok(!r.error && r.data[0].safety_notes === 'Hard hats', 'new column added automatically', r);
  // settings + idle minutes
  r = await tech.rpc('pestis_idle_minutes');
  ok(r.data === 5, 'idle minutes default 5', r);
  await boss.from('app_settings').upsert([{ key: 'idle_logout_minutes', value: 15 }], { onConflict: 'key' });
  r = await tech.rpc('pestis_idle_minutes');
  ok(r.data === 15, 'idle minutes from settings', r);
  // staff day log
  r = await tech.from('staff_days').insert([{ id: 'd1', started_at: new Date().toISOString(), technician: 'tech' }]);
  ok(!r.error, 'start day', r.error);
  r = await tech.from('staff_days').update({ ended_at: new Date().toISOString() }).eq('id', 'd1').select('id');
  ok(r.data && r.data.length === 1, 'end day', r);
  // prefs
  await tech.rpc('save_my_pref', { p_key: 'service_app', p_value: { theme: 'dark' } });
  r = await tech.rpc('get_my_prefs');
  ok(r.data && r.data.service_app && r.data.service_app.theme === 'dark', 'prefs saved', r);
  r = await tech.rpc('save_my_ui_prefs', { p_key: 'board', p_value: { cols: 3 } });
  r = await tech.from('profiles').select('ui_prefs').eq('id', tech.uid).single();
  ok(r.data.ui_prefs.board.cols === 3, 'ui prefs saved', r.data);
  r = await tech.rpc('portal_save_limit', {});
  ok(r.error && r.error.code === 'PGRST202', 'unknown function errors like Supabase', r.error);

  // ---------- client portal ----------
  r = await boss.from('client_users').insert({ email: 'Client@Acme.test ', full_name: 'Cara', company: 'Acme' });
  ok(!r.error, 'admin adds client login', r.error);
  r = await boss.from('client_access').insert([{ email: 'client@acme.test', client_id: '1' }]);
  ok(!r.error, 'admin gives client site 1', r.error);
  r = await boss.from('client_access').insert([{ email: 'ghost@acme.test', client_id: '1' }]);
  ok(r.error && r.error.code === '23503', 'access needs a client login', r.error);
  const cl = await as('client@acme.test');
  r = await cl.rpc('portal_whoami');
  ok(r.data && r.data.client && r.data.active && !r.data.staff && r.data.sites === 1, 'whoami: client', r.data);
  r = await cl.rpc('portal_sites');
  ok(r.data.length === 1 && r.data[0].Name === 'Acme Foods' && !('Notes' in r.data[0]) && !('safety_notes' in r.data[0]) && r.data[0].services[0].name === 'Rodent' && !('notes' in r.data[0].services[0]), 'portal_sites hides staff notes', r.data);
  r = await cl.from('clients').select('*');
  ok(r.data.length === 0, 'client cannot read the sites table directly', r.data);
  r = await cl.from('recommendations').select('id');
  ok(r.data.length === 1 && r.data[0].id === 'rec-a', 'client sees only their site recs', r.data);
  r = await cl.from('service_logs').select('id', { count: 'exact', head: true });
  ok(r.count === 4, 'client sees their site records', r);
  r = await cl.from('service_logs').insert({ client_id: 1, barcode_id: 'X' });
  ok(r.error && r.error.code === '42501', 'client cannot add records', r.error);
  r = await cl.from('recommendations').update({ text: 'hacked' }).eq('id', 'rec-a').select('id');
  ok(!r.error && r.data.length === 0, 'client update changes nothing', r);
  r = await cl.from('species').select('id');
  ok(r.data.length === sp.length + 1, 'client reads lists', r.data && r.data.length);   // the pest list, and the Wasp added above
  r = await cl.from('site_contacts').insert([{ client_id: '1', name: 'Client added' }]).select('*');
  ok(!r.error && r.data[0].updated_by === 'Cara · Acme (client)', 'client adds contact to own site', r);
  r = await cl.from('site_contacts').insert([{ client_id: '2', name: 'Nope' }]);
  ok(r.error && r.error.code === '42501', 'not to another site', r.error);
  r = await cl.rpc('portal_update_recommendation', { p_rec_id: 'rec-a', p_status: 'pending', p_note: 'Not fixed', p_photos: ['1/CLIENT_x.jpg'] });
  ok(!r.error && r.data.status === 'pending', 'client updates a rec', r);
  r = await cl.rpc('portal_update_recommendation', { p_rec_id: 'rec-b', p_status: 'pending', p_note: 'x' });
  ok(r.error && /not found/.test(r.error.message), 'not another site rec', r.error);
  r = await tech.from('recommendation_updates').select('*').eq('by_client', true);
  ok(r.data.length === 1 && r.data[0].technician === 'Cara · Acme (client)', 'staff see client update', r.data);
  r = await cl.rpc('pestis_mark_rec_viewed', { p_rec_id: 'rec-a' });
  r = await cl.rpc('pestis_mark_rec_viewed', { p_rec_id: 'rec-a' });
  r = await tech.from('recommendation_views').select('*').eq('rec_id', 'rec-a');
  ok(r.data.length === 1 && r.data[0].view_count === 2 && r.data[0].is_client === true, 'views counted', r.data);
  r = await cl.rpc('portal_report_sighting', { p_client_id: '1', p_pest: 'Rat', p_location: 'Dock', p_seen_at: new Date().toISOString(), p_urgency: 'Urgent' });
  ok(!r.error && r.data.no === 1, 'client reports sighting #1', r);
  r = await cl.rpc('portal_review_sighting', { p_id: r.data.id, p_note: 'ok' });
  ok(r.error && /not actioned/.test(r.error.message), 'cannot review before actioned', r.error);
  r = await cl.rpc('portal_technicians', { p_client_id: '1' });
  ok(Array.isArray(r.data) && r.data.some(t => t.name === 'tech'), 'technicians list', r.data);
  // turning the client login off
  await boss.from('client_users').update({ active: false }).eq('email', 'client@acme.test');
  r = await cl.from('recommendations').select('id');
  ok(r.data.length === 0, 'suspended client sees nothing', r.data);
  await boss.from('client_users').update({ active: true }).eq('email', 'client@acme.test');

  // ---------- files ----------
  r = await tech.storage.from('station-photos').upload('1/photo1.jpg', new Blob([Buffer.from('JPEGDATA')], { type: 'image/jpeg' }), { contentType: 'image/jpeg', upsert: false });
  ok(!r.error && r.data.path === '1/photo1.jpg', 'technician uploads a photo', r);
  r = await tech.storage.from('station-photos').upload('1/photo1.jpg', new Blob(['x']), { upsert: false });
  ok(r.error && String(r.error.statusCode) === '409' && /already exists/.test(r.error.message), 'duplicate upload refused like Supabase', r.error);
  await tech.storage.from('station-photos').upload('2/other.jpg', new Blob(['other']), { contentType: 'image/jpeg' });
  r = await cl.storage.from('station-photos').createSignedUrls(['1/photo1.jpg', '2/other.jpg', '1/missing.jpg'], 600);
  ok(r.data && r.data[0].signedUrl && !r.data[1].signedUrl && !r.data[2].signedUrl, 'client links: own site only', r.data);
  const f = await fetch(r.data[0].signedUrl);
  ok(f.ok && (await f.text()) === 'JPEGDATA' && f.headers.get('content-type') === 'image/jpeg', 'signed link downloads the file');
  const rg = await fetch(r.data[0].signedUrl, { headers: { Range: 'bytes=0-3' } });
  ok(rg.status === 206 && (await rg.text()) === 'JPEG', 'range request (videos)');
  const forged = await fetch(r.data[0].signedUrl.replace('photo1', 'photo2'));
  ok(forged.status === 403, 'changed link refused');
  r = await cl.storage.from('station-photos').upload('1/CLIENT_abc.jpg', new Blob(['c']), { contentType: 'image/jpeg' });
  ok(!r.error, 'client uploads recommendation photo', r.error);
  r = await cl.storage.from('station-photos').upload('1/sneaky.jpg', new Blob(['c']), {});
  ok(r.error && String(r.error.statusCode) === '403', 'client cannot upload other names', r.error);
  r = await tech.storage.from('site-documents').upload('1/sds.pdf', new Blob(['pdf']), { contentType: 'application/pdf' });
  ok(r.error, 'technician cannot upload documents (admin only)', r.error);
  r = await boss.storage.from('site-documents').upload('1/sds.pdf', new Blob(['pdf']), { contentType: 'application/pdf' });
  ok(!r.error, 'admin uploads a document', r.error);
  r = await tech.storage.from('site-documents').createSignedUrl('1/sds.pdf', 60);
  ok(r.data && r.data.signedUrl, 'technician opens a document', r);
  r = await tech.storage.from('station-photos').upload('../../etc/passwd', new Blob(['x']), {});
  ok(r.error, 'path escape refused', r.error);
  r = await tech.storage.from('station-photos').remove(['1/photo1.jpg']);
  ok(r.data && r.data.length === 1, 'remove photo', r);
  r = await tech.storage.from('station-photos').createSignedUrl('1/photo1.jpg', 60);
  ok(r.error, 'removed photo has no link', r);

  // ---------- live updates ----------
  const got = { cl: [], tech: [] };
  let subscribed = 0;
  const chC = cl.channel('portal-site-1').on('postgres_changes', { event: '*', schema: 'public', table: 'recommendations', filter: 'client_id=eq.1' }, p => got.cl.push(p))
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'recommendations' }, p => got.cl.push(p)).subscribe(s => { if (s === 'SUBSCRIBED') subscribed++; });
  const chT = tech.channel('pestis-team').on('postgres_changes', { event: '*', schema: 'public', table: 'clients' }, p => got.tech.push(p)).subscribe(s => { if (s === 'SUBSCRIBED') subscribed++; });
  for (let i = 0; i < 40 && subscribed < 2; i++) await new Promise(r => setTimeout(r, 50));
  ok(subscribed === 2, 'live: both subscribed');
  await tech.from('recommendations').insert([{ id: 'rec-live', client_id: '1', text: 'Live one' }]);
  await tech.from('recommendations').insert([{ id: 'rec-other', client_id: '2', text: 'Other site' }]);
  await tech.from('clients').update({ Address: '2 Main St' }).eq('id', 1);
  await tech.from('recommendations').delete().eq('id', 'rec-live');
  await new Promise(r => setTimeout(r, 400));
  ok(got.cl.length === 2 && got.cl[0].eventType === 'INSERT' && got.cl[0].new.id === 'rec-live' && got.cl[1].eventType === 'DELETE' && got.cl[1].old.id === 'rec-live',
    'client gets own-site insert + delete only (filtered listener gets no deletes)', got.cl.map(p => [p.eventType, p.new.id || p.old.id]));
  ok(got.tech.length >= 1 && got.tech.some(p => p.eventType === 'UPDATE' && p.new.Address === '2 Main St'), 'staff get site changes', got.tech.length);
  cl.removeChannel(chC); tech.removeChannel(chT);

  // ---------- a visit in progress: the client sees its results only when it's finished ----------
  const logsBefore = (await cl.from('service_logs').select('id', { count: 'exact', head: true })).count;
  await tech.from('clients').update({ visit_started_at: new Date().toISOString(), visit_started_by: tech.uid }).eq('id', 1);
  const held = { cl: [], tech: [] };
  let subs = 0;
  const holdTables = ['service_logs', 'recommendations', 'recommendation_updates', 'stations', 'visits'];
  let chH = cl.channel('portal-site-1-hold');
  holdTables.forEach(t => { chH = chH.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: 'client_id=eq.1' }, p => held.cl.push(p)); });
  chH = chH.subscribe(s => { if (s === 'SUBSCRIBED') subs++; });
  const chH2 = tech.channel('pestis-hold').on('postgres_changes', { event: '*', schema: 'public', table: 'service_logs' }, p => held.tech.push(p)).subscribe(s => { if (s === 'SUBSCRIBED') subs++; });
  for (let i = 0; i < 40 && subs < 2; i++) await new Promise(r => setTimeout(r, 50));
  await tech.from('service_logs').insert([{ client_id: 1, barcode_id: 'B1', payload: { activityLevel: 'High' } }]);
  await tech.from('recommendations').insert([{ id: 'rec-visit', client_id: '1', text: 'Found during the visit' }]);
  await tech.from('stations').insert([{ id: 's-visit', client_id: '1', barcode: 'NEW-V', name: 'New in visit' }]);
  r = await cl.rpc('portal_update_recommendation', { p_rec_id: 'rec-a', p_status: 'pending', p_note: 'Client note during visit' });
  await new Promise(r => setTimeout(r, 300));
  r = await cl.from('service_logs').select('id', { count: 'exact', head: true });
  ok(r.count === logsBefore, 'visit in progress: client does not see its station checks', [r.count, logsBefore]);
  r = await cl.from('recommendations').select('id');
  ok(!r.data.some(x => x.id === 'rec-visit') && r.data.some(x => x.id === 'rec-a'), 'visit in progress: new recommendation hidden, earlier ones still shown', r.data);
  r = await cl.from('stations').select('id');
  ok(!r.data.some(x => x.id === 's-visit') && r.data.some(x => x.id === 's1'), 'visit in progress: new station hidden, existing stations shown', r.data);
  r = await cl.from('recommendation_updates').select('note');
  ok(r.data.some(x => x.note === 'Client note during visit'), "visit in progress: the client's own update still shows", r.data);
  // (the client's own update, and the earlier recommendation it changed, do come through)
  ok(!held.cl.some(p => p.table !== 'recommendation_updates' && !(p.table === 'recommendations' && p.new.id === 'rec-a')), 'visit in progress: no live updates of its records to the client', held.cl.map(p => [p.table, p.new.id]));
  ok(held.tech.some(p => p.new.barcode_id === 'B1'), 'staff still see the visit live');
  r = await tech.from('service_logs').select('id', { count: 'exact', head: true }).eq('client_id', 1);
  ok(r.count === logsBefore + 1, 'staff see every record', r.count);
  // the visit is finished
  held.cl.length = 0;
  await tech.from('visits').insert([{ id: 'visit-done', client_id: '1', technician: 'tech', visit_type: 'Routine Service' }]);
  await tech.from('clients').update({ visit_started_at: null, visit_started_by: null }).eq('id', 1);
  await new Promise(r => setTimeout(r, 400));
  r = await cl.from('service_logs').select('id', { count: 'exact', head: true });
  ok(r.count === logsBefore + 1, 'visit finished: client sees its station checks', r.count);
  r = await cl.from('recommendations').select('id');
  ok(r.data.some(x => x.id === 'rec-visit'), 'visit finished: client sees the new recommendation');
  const seenTables = new Set(held.cl.filter(p => p.eventType === 'INSERT').map(p => p.table));
  ok(['service_logs', 'recommendations', 'stations', 'visits'].every(t => seenTables.has(t)), 'visit finished: everything held back arrives live', [...seenTables]);
  ok(!held.tech.some(p => p.new.barcode_id === 'B1' && held.tech.filter(x => x.new.barcode_id === 'B1').length > 1), 'staff are not sent the records twice');
  cl.removeChannel(chH); tech.removeChannel(chH2);

  // ---------- emailed sign-in link ----------
  r = await cl.auth.signInWithOtp({ email: 'client@acme.test', options: { emailRedirectTo: BASE + '/client.html' } });
  ok(!r.error, 'ask for a sign-in link', r.error);
  await new Promise(r => setTimeout(r, 300));
  const mail = mails.join('\n');
  const body = Buffer.from((mail.split('Content-Type: text/plain; charset=UTF-8')[1] || '').split('--pestis')[0].replace(/Content-Transfer-Encoding: base64/, '').replace(/\s+/g, ''), 'base64').toString();
  const link = (/(http:\/\/\S+\/auth\/callback\?link=\S+)/.exec(body) || [])[1];
  ok(!!link, 'email has a link', mail.slice(0, 300));
  const token = new URL(link).searchParams.get('link');
  let v = await fetch(BASE + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  let vj = await v.json();
  ok(v.ok && vj.session && vj.session.user.email === 'client@acme.test' && vj.redirectTo === '/client.html', 'link signs in and goes back to the portal', vj);
  v = await fetch(BASE + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  ok(v.status === 401, 'link works once');
  const before = mails.length;
  r = await cl.auth.signInWithOtp({ email: 'random@nowhere.test' });
  await new Promise(r => setTimeout(r, 200));
  ok(!r.error && mails.length === before, 'unknown email: same answer, no email sent');

  // ---------- only the apps are public ----------
  for (const [u, want] of [['/', 200], ['/client.html', 200], ['/pestis-db.js', 200], ['/images/pesties-logo.png', 200], ['/server/server.mjs', 404], ['/src/admin_src.html', 404], ['/tests/harness.mjs', 404], ['/CLAUDE.md', 404], ['/.git/config', 404]]) {
    const res = await fetch(BASE + u);
    ok(res.status === want, `${u} answers ${want}`, res.status);
  }

  // ---------- sign out ----------
  const tokT = JSON.parse(store.get('sb-tech@example.com-auth-token')).access_token;
  const events = [];
  tech.auth.onAuthStateChange(e => events.push(e));
  await new Promise(r => setTimeout(r, 10));
  await tech.auth.signOut();
  const after = await fetch(BASE + '/api/db', { method: 'POST', headers: { Authorization: 'Bearer ' + tokT, 'Content-Type': 'application/json' }, body: '{"table":"clients"}' });
  ok(after.status === 401 && events.includes('SIGNED_OUT'), 'signed out on the server too', events);
  const s = await tech.auth.getSession();
  ok(s.data.session === null, 'session gone locally');
  // removing a person signs them out
  await boss.from('profiles').delete().eq('id', stranger.uid);
  r = await stranger.from('profiles').select('*').eq('id', stranger.uid);
  ok(r.data.length === 0, 'deleted profile');
} catch (e) { fails++; console.log('ERROR', e); }
finally {
  srv.stop();
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}
