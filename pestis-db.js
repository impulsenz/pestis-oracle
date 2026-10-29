/* Pestis database connection for the Pestis server (SQLite on your own Oracle Cloud server).
   It stands in for the supabase-js library: the apps call the same functions (from(), rpc(), auth, storage,
   channel()) and this file sends them to the Pestis server at the same web address as the apps. */
(function () {
  'use strict';

  const now = () => Date.now();
  const fetchError = e => ({ message: `${(e && e.name) || 'FetchError'}: ${(e && e.message) || e}`, details: String((e && e.stack) || ''), hint: '', code: String((e && e.code) || '') });

  class Client {
    constructor(url, options) {
      this.url = String(url || location.origin).replace(/\/+$/, '');
      const auth = (options && options.auth) || {};
      this.storageKey = auth.storageKey || ('sb-' + this.url.replace(/^https?:\/\//, '').split('.')[0] + '-auth-token');
      this.auth = new Auth(this);
      this.storage = new Storage(this);
      this.live = new Live(this);
    }
    from(table) { return new Query(this, table); }
    rpc(name, args, opts) { return new Rpc(this, name, args || {}, opts || {}); }
    channel(name) { return new Channel(this.live, name); }
    removeChannel(ch) { if (ch && ch.unsubscribe) ch.unsubscribe(); return Promise.resolve('ok'); }
    removeAllChannels() { [...this.live.channels].forEach(ch => ch.unsubscribe()); return Promise.resolve(['ok']); }
    getChannels() { return [...this.live.channels]; }
    token() { const s = this.auth._read(); return s && s.access_token; }
    async request(path, init) {
      init = Object.assign({}, init);
      const headers = Object.assign({}, init.headers || {});
      const tok = this.token();
      if (tok) headers.Authorization = 'Bearer ' + tok;
      if (init.json !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(init.json); delete init.json; }
      init.headers = headers;
      init.cache = 'no-store';
      const res = await fetch(this.url + path, init);
      // how much was sent (the Service App shows the data uploaded on each visit)
      const sent = typeof init.body === 'string' ? new Blob([init.body]).size : (init.body && init.body.size) || 0;
      if (sent && this.onSent) { try { this.onSent(sent); } catch (e) {} }
      if (res.status === 401 && tok) {
        const j = await res.clone().json().catch(() => ({}));
        if (j && j.code === 'session_not_found') this.auth._ended();
      }
      return res;
    }
  }

  /* ---------------- database ---------------- */
  class Query {
    constructor(client, table) {
      this.c = client;
      this.q = { table, op: 'select', select: '*', filters: [], order: [] };
      this._single = null; this._throw = false; this._signal = null; this._err = null;
    }
    select(cols, opts) {
      opts = opts || {};
      if (this.q.op === 'select') { this.q.select = cols == null ? '*' : cols; if (opts.head) this.q.head = true; }
      else { this.q.returning = true; this.q.select = cols == null ? '*' : cols; }
      if (opts.count) this.q.count = opts.count;
      return this;
    }
    insert(values, opts) { this.q.op = 'insert'; this.q.values = values; if (opts && opts.count) this.q.count = opts.count; return this; }
    upsert(values, opts) {
      opts = opts || {};
      this.q.op = 'upsert'; this.q.values = values;
      if (opts.onConflict) this.q.onConflict = opts.onConflict;
      if (opts.ignoreDuplicates) this.q.ignoreDuplicates = true;
      if (opts.count) this.q.count = opts.count;
      return this;
    }
    update(values, opts) { this.q.op = 'update'; this.q.values = values; if (opts && opts.count) this.q.count = opts.count; return this; }
    delete(opts) { this.q.op = 'delete'; if (opts && opts.count) this.q.count = opts.count; return this; }
    _f(col, op, val) { this.q.filters.push([col, op, val]); return this; }
    eq(c, v) { return this._f(c, 'eq', v); }
    neq(c, v) { return this._f(c, 'neq', v); }
    gt(c, v) { return this._f(c, 'gt', v); }
    gte(c, v) { return this._f(c, 'gte', v); }
    lt(c, v) { return this._f(c, 'lt', v); }
    lte(c, v) { return this._f(c, 'lte', v); }
    like(c, v) { return this._f(c, 'like', v); }
    ilike(c, v) { return this._f(c, 'ilike', v); }
    is(c, v) { return this._f(c, 'is', v); }
    in(c, v) { return this._f(c, 'in', Array.from(v || [])); }
    contains(c, v) { return this._f(c, 'cs', v); }
    match(obj) { Object.entries(obj || {}).forEach(([k, v]) => this._f(k, 'eq', v)); return this; }
    not(c, op, v) {
      if (op === 'in' && typeof v === 'string') v = v.replace(/^\(|\)$/g, '').split(',').map(x => x.trim().replace(/^"(.*)"$/, '$1'));
      if (op === 'is' && v === 'null') v = null;
      this.q.filters.push([c, 'not', op, v]); return this;
    }
    filter(c, op, v) {
      if (op === 'in' && typeof v === 'string') v = v.replace(/^\(|\)$/g, '').split(',').map(x => x.trim().replace(/^"(.*)"$/, '$1'));
      if (op === 'is' && v === 'null') v = null;
      return this._f(c, op, v);
    }
    or() { this._err = { message: 'or() filters are not supported by the Pestis server', code: 'PGRST100', details: null, hint: null }; return this; }
    order(col, opts) { opts = opts || {}; this.q.order.push([col, opts.ascending !== false, opts.nullsFirst]); return this; }
    limit(n) { this.q.limit = n; return this; }
    range(from, to) { this.q.offset = from; this.q.limit = to - from + 1; return this; }
    single() { this._single = 'one'; return this; }
    maybeSingle() { this._single = 'maybe'; return this; }
    abortSignal(s) { this._signal = s; return this; }
    throwOnError() { this._throw = true; return this; }
    returns() { return this; }
    async _run() {
      if (this._err) return { data: null, error: this._err, count: null, status: 400, statusText: 'Bad Request' };
      let res, body;
      try {
        res = await this.c.request('/api/db', { method: 'POST', json: this.q, signal: this._signal || undefined });
        body = await res.json().catch(() => ({}));
      } catch (e) {
        return { data: null, error: fetchError(e), count: null, status: 0, statusText: '' };
      }
      if (!res.ok || body.error) {
        const error = body.error && typeof body.error === 'object' ? body.error : { message: body.message || body.error || ('HTTP ' + res.status), code: body.code || '', details: null, hint: null };
        return { data: null, error, count: null, status: res.status, statusText: res.statusText };
      }
      let data = body.data, status = res.status;
      if (this._single && Array.isArray(data)) {
        if (data.length === 1) data = data[0];
        else if (this._single === 'maybe' && data.length === 0) data = null;
        else return { data: null, count: null, status: 406, statusText: 'Not Acceptable',
          error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${data.length} rows`, hint: null } };
      }
      if ((this.q.op === 'insert' || this.q.op === 'upsert') && !this.q.returning) status = 201;
      return { data: data === undefined ? null : data, error: null, count: body.count == null ? null : body.count, status, statusText: 'OK' };
    }
    then(resolve, reject) {
      return this._run().then(r => { if (this._throw && r.error) throw Object.assign(new Error(r.error.message), r.error); return r; }).then(resolve, reject);
    }
    catch(reject) { return this.then(undefined, reject); }
    finally(fn) { return this.then(v => { fn(); return v; }, e => { fn(); throw e; }); }
  }

  class Rpc {
    constructor(client, name, args) { this.c = client; this.name = name; this.args = args; this._single = null; this._signal = null; }
    single() { this._single = 'one'; return this; }
    maybeSingle() { this._single = 'maybe'; return this; }
    abortSignal(s) { this._signal = s; return this; }
    throwOnError() { this._throw = true; return this; }
    async _run() {
      let res, body;
      try {
        res = await this.c.request('/api/rpc/' + encodeURIComponent(this.name), { method: 'POST', json: this.args, signal: this._signal || undefined });
        body = await res.json().catch(() => ({}));
      } catch (e) { return { data: null, error: fetchError(e), count: null, status: 0, statusText: '' }; }
      if (!res.ok || body.error) {
        const error = body.error && typeof body.error === 'object' ? body.error : { message: body.message || ('HTTP ' + res.status), code: body.code || '', details: null, hint: null };
        return { data: null, error, count: null, status: res.status, statusText: res.statusText };
      }
      let data = body.data === undefined ? null : body.data;
      if (this._single && Array.isArray(data)) data = data.length ? data[0] : null;
      return { data, error: null, count: null, status: res.status, statusText: 'OK' };
    }
    then(resolve, reject) {
      return this._run().then(r => { if (this._throw && r.error) throw Object.assign(new Error(r.error.message), r.error); return r; }).then(resolve, reject);
    }
    catch(reject) { return this.then(undefined, reject); }
    finally(fn) { return this.then(v => { fn(); return v; }, e => { fn(); throw e; }); }
  }

  /* ---------------- sign-in ---------------- */
  class Auth {
    constructor(client) {
      this.c = client;
      this.subs = new Set();
      this._last = this._read() ? 'in' : 'out';
      window.addEventListener('storage', e => {
        if (e.key !== this.c.storageKey) return;
        const s = this._read();
        this._emit(s ? 'SIGNED_IN' : 'SIGNED_OUT', s);
      });
    }
    _read() {
      try { const s = JSON.parse(localStorage.getItem(this.c.storageKey) || 'null'); return s && s.access_token ? s : null; } catch (e) { return null; }
    }
    _emit(event, session) {
      this._last = session ? 'in' : 'out';
      this.subs.forEach(fn => { try { fn(event, session); } catch (e) { console.error(e); } });
    }
    _ended() {   // the server says this sign-in has ended (signed out elsewhere, expired, or the account was removed)
      if (!this._read()) return;
      try { localStorage.removeItem(this.c.storageKey); } catch (e) {}
      this._emit('SIGNED_OUT', null);
    }
    async getSession() {
      const s = this._read();
      if (s && s.expires_at && s.expires_at * 1000 < now()) { try { localStorage.removeItem(this.c.storageKey); } catch (e) {} return { data: { session: null }, error: null }; }
      return { data: { session: s }, error: null };
    }
    async getUser() {
      try {
        const res = await this.c.request('/api/auth/user', { method: 'GET' });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) return { data: { user: null }, error: { message: j.error || 'Not signed in', status: res.status } };
        return { data: { user: j.user }, error: null };
      } catch (e) { return { data: { user: null }, error: fetchError(e) }; }
    }
    async refreshSession() { const r = await this.getSession(); return { data: { session: r.data.session, user: r.data.session && r.data.session.user }, error: null }; }
    onAuthStateChange(fn) {
      this.subs.add(fn);
      setTimeout(() => { if (this.subs.has(fn)) try { fn('INITIAL_SESSION', this._read()); } catch (e) { console.error(e); } }, 0);
      return { data: { subscription: { id: Math.random().toString(36).slice(2), unsubscribe: () => this.subs.delete(fn) } } };
    }
    async _config() {
      try {
        const res = await fetch(this.c.url + '/api/auth/config', { cache: 'no-store' });
        const j = await res.json();
        try { localStorage.setItem('pestis-auth-config', JSON.stringify(j)); } catch (e) {}
        return j;
      } catch (e) {
        try { return JSON.parse(localStorage.getItem('pestis-auth-config') || '{}'); } catch (e2) { return {}; }
      }
    }
    async signInWithOAuth(args) {
      args = args || {};
      const opts = args.options || {};
      if (args.provider && args.provider !== 'google') return { data: null, error: { message: 'Only Google sign-in is available' } };
      const cfg = await this._config();
      if (!cfg.google) return { data: null, error: { message: "Google sign-in isn't set up on this server yet. In /etc/pestis.env set GOOGLE_CLIENT_ID (see SETUP.md)." } };
      const rnd = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), b => b.toString(16).padStart(2, '0')).join('');
      const state = rnd(), nonce = rnd();
      try { sessionStorage.setItem('pestis-google-signin', JSON.stringify({ state, nonce, redirectTo: opts.redirectTo || location.href, at: now() })); } catch (e) {}
      const p = new URLSearchParams({ client_id: cfg.google, redirect_uri: this.c.url + '/auth/callback', response_type: 'id_token',
        scope: 'openid email profile', nonce, state, prompt: 'select_account' });
      Object.entries(opts.queryParams || {}).forEach(([k, v]) => p.set(k, v));
      const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
      if (!opts.skipBrowserRedirect) location.assign(url);
      return { data: { provider: 'google', url }, error: null };
    }
    async signInWithOtp(args) {
      args = args || {};
      try {
        const res = await fetch(this.c.url + '/api/auth/magic', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
          body: JSON.stringify({ email: args.email, redirectTo: (args.options && args.options.emailRedirectTo) || location.href }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) return { data: { user: null, session: null }, error: { message: j.error || ('HTTP ' + res.status), status: res.status } };
        return { data: { user: null, session: null }, error: null };
      } catch (e) { return { data: { user: null, session: null }, error: fetchError(e) }; }
    }
    async signOut(opts) {
      const s = this._read();
      try { localStorage.removeItem(this.c.storageKey); } catch (e) {}
      this.c.live.stop();
      if (s) this._emit('SIGNED_OUT', null);
      if (s && !(opts && opts.scope === 'local')) {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const t = setTimeout(() => ctrl && ctrl.abort(), 4000);
        try {
          await fetch(this.c.url + '/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: (opts && opts.scope) || 'local' }), signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' });
        } catch (e) {} finally { clearTimeout(t); }
      }
      return { error: null };
    }
  }

  /* ---------------- photos and documents ---------------- */
  class Bucket {
    constructor(client, bucket) { this.c = client; this.b = bucket; }
    _p(path) { return String(path || '').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/'); }
    async _json(res) {
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return { data: null, error: { message: j.message || j.error || ('HTTP ' + res.status), statusCode: j.statusCode || String(res.status), status: res.status, error: j.error } };
      return { data: j, error: null };
    }
    async upload(path, body, opts) {
      opts = opts || {};
      try {
        const type = opts.contentType || (body && body.type) || 'application/octet-stream';
        const res = await this.c.request(`/api/storage/upload/${encodeURIComponent(this.b)}/${this._p(path)}`, { method: 'POST', body,
          headers: { 'Content-Type': type, 'x-upsert': opts.upsert ? 'true' : 'false' } });
        const r = await this._json(res);
        if (r.error) return r;
        return { data: { path: r.data.path, id: r.data.id, fullPath: r.data.Key }, error: null };
      } catch (e) { return { data: null, error: fetchError(e) }; }
    }
    update(path, body, opts) { return this.upload(path, body, Object.assign({}, opts, { upsert: true })); }
    async createSignedUrl(path, expiresIn) {
      try {
        const res = await this.c.request(`/api/storage/sign/${encodeURIComponent(this.b)}`, { method: 'POST', json: { path, expiresIn } });
        const r = await this._json(res);
        if (r.error) return r;
        return { data: { signedUrl: r.data.signedUrl }, error: null };
      } catch (e) { return { data: null, error: fetchError(e) }; }
    }
    async createSignedUrls(paths, expiresIn) {
      try {
        const res = await this.c.request(`/api/storage/sign/${encodeURIComponent(this.b)}`, { method: 'POST', json: { paths: Array.from(paths || []), expiresIn } });
        return await this._json(res);
      } catch (e) { return { data: null, error: fetchError(e) }; }
    }
    async remove(paths) {
      try {
        const res = await this.c.request(`/api/storage/remove/${encodeURIComponent(this.b)}`, { method: 'POST', json: { paths: Array.from(paths || []) } });
        return await this._json(res);
      } catch (e) { return { data: null, error: fetchError(e) }; }
    }
    async download(path) {
      const s = await this.createSignedUrl(path, 60);
      if (s.error) return { data: null, error: s.error };
      try { const res = await fetch(s.data.signedUrl); if (!res.ok) return { data: null, error: { message: 'HTTP ' + res.status } }; return { data: await res.blob(), error: null }; }
      catch (e) { return { data: null, error: fetchError(e) }; }
    }
    getPublicUrl() { return { data: { publicUrl: '' } }; }
  }
  class Storage {
    constructor(client) { this.c = client; }
    from(bucket) { return new Bucket(this.c, bucket); }
  }

  /* ---------------- live updates ---------------- */
  function matchFilter(filter, row) {
    if (!filter) return true;
    const m = /^([^=]+)=(eq|neq|lt|lte|gt|gte|in)\.(.*)$/.exec(filter);
    if (!m) return true;
    const v = row ? row[m[1]] : undefined, s = v == null ? null : String(v), want = m[3];
    switch (m[2]) {
      case 'eq': return s === want;
      case 'neq': return s !== want;
      case 'in': return want.replace(/^\(|\)$/g, '').split(',').map(x => x.trim().replace(/^"(.*)"$/, '$1')).includes(s);
      case 'lt': return v != null && (isNaN(v) ? s < want : Number(v) < Number(want));
      case 'lte': return v != null && (isNaN(v) ? s <= want : Number(v) <= Number(want));
      case 'gt': return v != null && (isNaN(v) ? s > want : Number(v) > Number(want));
      case 'gte': return v != null && (isNaN(v) ? s >= want : Number(v) >= Number(want));
    }
    return true;
  }
  class Channel {
    constructor(live, name) { this.live = live; this.topic = 'realtime:' + name; this.name = name; this.handlers = []; this.cb = null; this.state = 'closed'; }
    on(type, filter, cb) {
      if (type === 'postgres_changes') this.handlers.push({ event: (filter && filter.event) || '*', table: (filter && filter.table) || '*', filter: filter && filter.filter, cb });
      return this;
    }
    subscribe(cb) { this.cb = cb || null; this.live.add(this); return this; }
    unsubscribe() { this.live.remove(this); this._status('CLOSED'); return Promise.resolve('ok'); }
    send() { return Promise.resolve('ok'); }
    _status(s, err) { this.state = s; if (this.cb) try { this.cb(s, err); } catch (e) { console.error(e); } }
    _deliver(p) {
      for (const h of this.handlers) {
        if (h.table !== '*' && h.table !== p.table) continue;
        if (h.event !== '*' && h.event !== p.eventType) continue;
        if (h.filter && (p.eventType === 'DELETE' || !matchFilter(h.filter, p.new))) continue;   // like Supabase: filtered listeners don't get deletes
        try { h.cb(p); } catch (e) { console.error(e); }
      }
    }
  }
  class Live {
    constructor(client) {
      this.c = client; this.channels = new Set(); this.ctrl = null; this.ready = false; this.retry = 0; this.timer = null;
      window.addEventListener('online', () => { if (this.channels.size && !this.ctrl) { this.retry = 0; this.connect(); } });
    }
    add(ch) { this.channels.add(ch); if (this.ready) ch._status('SUBSCRIBED'); else { ch._status('CONNECTING'); this.connect(); } }
    remove(ch) { this.channels.delete(ch); if (!this.channels.size) this.stop(); }
    stop() { clearTimeout(this.timer); this.timer = null; this.ready = false; if (this.ctrl) { try { this.ctrl.abort(); } catch (e) {} this.ctrl = null; } }
    later() {
      clearTimeout(this.timer);
      if (!this.channels.size) return;
      const wait = Math.min(30000, 1500 * Math.pow(2, this.retry++));
      this.timer = setTimeout(() => this.connect(), wait);
    }
    async connect() {
      if (this.ctrl || !this.channels.size) return;
      const tok = this.c.token();
      if (!tok || (typeof navigator !== 'undefined' && navigator.onLine === false)) { this.later(); return; }
      const ctrl = new AbortController();
      this.ctrl = ctrl;
      try {
        const res = await fetch(this.c.url + '/api/live', { headers: { Authorization: 'Bearer ' + tok, Accept: 'text/event-stream' }, signal: ctrl.signal, cache: 'no-store' });
        if (res.status === 401) { const j = await res.json().catch(() => ({})); if (j.code === 'session_not_found') this.c.auth._ended(); throw new Error('signed out'); }
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            let event = 'message', data = '';
            block.split('\n').forEach(line => { if (line.startsWith('event:')) event = line.slice(6).trim(); else if (line.startsWith('data:')) data += line.slice(5).trim(); });
            if (event === 'ready') { this.ready = true; this.retry = 0; this.channels.forEach(ch => ch._status('SUBSCRIBED')); }
            else if (event === 'signed-out') this.c.auth._ended();
            else if (event === 'message' && data) { let p; try { p = JSON.parse(data); } catch (e) { continue; } this.channels.forEach(ch => ch._deliver(p)); }
          }
        }
        throw new Error('closed');
      } catch (e) {
        if (this.ctrl !== ctrl) return;   // stopped on purpose
        this.ctrl = null; this.ready = false;
        this.channels.forEach(ch => ch._status('CHANNEL_ERROR', e));
        this.later();
      }
    }
  }

  window.supabase = { createClient: (url, key, options) => new Client(url, options) };
  window.PestisDB = { Client };
})();
