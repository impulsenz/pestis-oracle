/* PESTIS-REPORTS:BEGIN - shared reports (identical in the Client Portal and Admin; edit reports_shared.js and run sync_reports.py) */
// ===================================================================
//  REPORTS: one report per job, each with only the filters it needs, a chart and a table,
//  and Download (CSV for Excel) / Print (or save as PDF) on every one.
//  PR.build(raw) turns a site's records into one shape; PR.render(box, data, opts) draws the reports.
// ===================================================================
const PR = (() => {
    const NONE_P = 'None - Monitoring Only', NONE_S = 'None';
    const META = new Set(['SITE_VISIT_SUMMARY', 'REC_UPDATE', 'SITE_MAP', 'MAP_PIN', 'BARCODE_CHANGE', 'SITE_CHANGE']);
    const e = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const parse = p => { if (typeof p === 'string') { try { return JSON.parse(p); } catch (x) { return {}; } } return p || {}; };
    const DAY = 86400000;
    const LOC = 'en-NZ';
    const fmtD = t => t ? new Date(t).toLocaleDateString(LOC, { day: 'numeric', month: 'short', year: 'numeric' }) : '-';
    const fmtDT = t => t ? new Date(t).toLocaleString(LOC, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-';
    const fmtDTS = t => t ? new Date(t).toLocaleString(LOC, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '-';   // to the second
    // a station's name that opens its own report (its history and chart)
    const stLink = (opts, x) => `${dot(opts, x.type)}<button type="button" class="pr-link" data-b="${e(x.barcode)}" onclick="PR.station(this, this.dataset.b)" title="Show this station's history"><b>${e(x.name)}</b></button>`;
    // a preparation's name that opens its safety data sheet (when there is one)
    const prepLink = (opts, name, bold) => { const id = name && opts.sdsOf ? opts.sdsOf(name) : null; const t = bold ? `<b>${e(name)}</b>` : e(name); return id ? `<button type="button" class="pr-link" data-id="${e(id)}" onclick="PR.sds(this, this.dataset.id)" title="Open the safety data sheet">${t} <span class="pr-sds">SDS ↗</span></button>` : t; };
    const monthKey = t => { const d = new Date(t); return d.getFullYear() * 12 + d.getMonth(); };
    const monthStart = k => new Date(Math.floor(k / 12), k % 12, 1).getTime();
    const monthLbl = k => new Date(Math.floor(k / 12), k % 12, 1).toLocaleDateString(LOC, { month: 'short', year: '2-digit' });
    const monthLong = k => new Date(Math.floor(k / 12), k % 12, 1).toLocaleDateString(LOC, { month: 'long', year: 'numeric' });
    const pestKey = p => String(p || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
    const PALETTE = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#dc2626', '#0891b2', '#ca8a04', '#db2777', '#64748b'];
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

    // ---------- the data, in one shape ----------
    function build(raw) {
        const logs = raw.logs || [];
        const superseded = new Set(logs.map(r => parse(r.payload).supersedes).filter(Boolean));
        const maps = new Map((raw.maps || []).filter(m => !m.deleted).map(m => [String(m.id), m.name || 'Floor plan']));
        const st = new Map();
        (raw.stations || []).forEach(s => st.set(s.barcode, { barcode: s.barcode, name: s.name || s.barcode, type: s.type || '', map: maps.get(String(s.map_id)) || '', limitId: s.limit_id || '', entries: [], table: true }));
        const entries = [];
        logs.forEach(r => {
            const p = parse(r.payload);
            if (META.has(r.barcode_id) || p.recOnly) return;
            const key = p.clientRef || (r.barcode_id + '@' + r.created_at);
            if (superseded.has(key)) return;
            const at = Date.parse(p.servicedAt) || Date.parse(r.created_at);
            if (isNaN(at)) return;
            const species = p.speciesCaught && p.speciesCaught !== NONE_S ? p.speciesCaught : '';
            const prep = p.prepUsed && p.prepUsed !== NONE_P ? p.prepUsed : '';
            let s = st.get(r.barcode_id);
            if (!s) { s = { barcode: r.barcode_id, name: p.locationName || r.barcode_id, type: p.deviceType || '', map: '', limitId: '', entries: [] }; st.set(r.barcode_id, s); }
            if (!s.table) { s.name = p.locationName || s.name; s.type = p.deviceType || s.type; }
            const en = { at, barcode: r.barcode_id, stationObj: s, activity: p.activityLevel || 'None', species, count: species ? (Number(p.pestCount) > 0 ? Number(p.pestCount) : 1) : 0,
                prep, qty: prep && p.quantity != null && !isNaN(p.quantity) ? Number(p.quantity) : null, unit: prep ? (p.quantityUnit || 'each') : '', batch: prep ? (p.batchNumber || '') : '',
                tech: p.technician || '', notes: p.notes || '' };
            entries.push(en); s.entries.push(en);
            // more pests on the same check (insect stations): a record each, the preparation only on the first
            (Array.isArray(p.morePests) ? p.morePests : []).forEach(x => {
                if (!x || !x.species || x.species === NONE_S) return;
                const more = Object.assign({}, en, { species: x.species, activity: x.activity || 'Caught', count: Number(x.count) > 0 ? Number(x.count) : 1, prep: '', qty: null, unit: '', batch: '', extra: true });
                entries.push(more); s.entries.push(more);
            });
        });
        entries.sort((a, b) => a.at - b.at);
        entries.forEach(en => { en.station = en.stationObj.name; en.type = en.stationObj.type; en.map = en.stationObj.map; });
        const stations = Array.from(st.values()).map(s => { s.entries.sort((a, b) => a.at - b.at); const checks = s.entries.filter(x => !x.extra), last = checks[checks.length - 1]; return Object.assign(s, { last: last || null, lastAt: last ? last.at : null }); })
            .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
        const visits = (raw.visits || []).map(v => {
            const start = Date.parse(v.signed_in_at || v.started_at) || null, end = Date.parse(v.signed_out_at || v.completed_at) || Date.parse(v.created_at) || null;
            return { start, end, at: end || start, type: v.visit_type || 'Routine Service', tech: v.technician || '' };
        }).filter(v => v.at).sort((a, b) => a.at - b.at);
        let vi = 0;
        visits.forEach(v => { v.n = 0; });
        entries.forEach(en => { while (vi < visits.length && en.at > visits[vi].at + 5 * 60000) vi++; if (vi < visits.length) visits[vi].n++; });
        const recs = (raw.recs || []).map(r => {
            const s = st.get(r.station_barcode);
            return { id: r.id, no: r.rec_no, station: (s && s.name) || r.station_name || r.station_barcode || 'Site', text: r.text || '', category: r.category || 'Other',
                status: r.status === 'new' ? 'open' : (r.status || 'open'), raisedAt: Date.parse(r.raised_at || r.created_at) || null, completedAt: Date.parse(r.completed_at) || null };
        }).filter(r => r.raisedAt);
        const limits = (raw.limits || []).filter(l => !l.deleted).map(l => {
            let rules = l.rules; if (typeof rules === 'string') { try { rules = JSON.parse(rules); } catch (x) { rules = []; } }
            return { id: String(l.id), name: l.name || 'Critical limit', rules: (Array.isArray(rules) ? rules : []).filter(x => x && x.species).map(x => ({ species: String(x.species), max: Number(x.max) || 0 })) };
        }).sort((a, b) => a.name.localeCompare(b.name));
        // the pests to choose from: the Admin pest list when it's given
        const species = Array.isArray(raw.species) && raw.species.length ? raw.species.slice() : null;
        // every station type (the Admin list, and any other type a station has), whether or not it has records
        const seenT = new Map();
        (raw.stationTypes || []).concat(stations.map(x => x.type)).forEach(t => { t = String(t || '').trim(); if (t && !seenT.has(t.toLowerCase())) seenT.set(t.toLowerCase(), t); });
        const types = Array.from(seenT.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        return { site: raw.siteName || '', entries, stations, visits, recs, limits, species, types };
    }

    // ---------- the reports ----------
    const REPORTS = [
        { id: 'trend', icon: '📈', title: 'Pest activity over time', blurb: 'Captures each month, one line per pest - or each year on top of the last to compare.', f: ['view', 'period', 'years', 'type', 'station', 'pest'] },
        { id: 'pests', icon: '🐞', title: 'Pests found', blurb: 'Which pests were found, how many, and the stations they were recorded on.', f: ['period', 'type', 'station', 'pest'] },
        { id: 'stations', icon: '📍', title: 'Busiest stations', blurb: 'The stations catching the most - where to focus.', f: ['period', 'type', 'station', 'pest'] },
        { id: 'station', icon: '🔎', title: 'One station', blurb: 'A single station: each pest (or its activity) month by month over the years, and every visit to it.', f: ['type', 'station', 'view', 'years', 'pest'] },
        { id: 'scanned', icon: '✅', title: 'Last scanned', blurb: 'Every station and when it was last checked - spot any missed.', f: ['type', 'station', 'map', 'gap'] },
        { id: 'preps', icon: '🧪', title: 'Preparations used', blurb: 'What was used on which station, how much, and the batch numbers.', f: ['period', 'type', 'station', 'prep', 'batch'] },
        { id: 'limits', icon: '⚠️', title: 'Critical limits', blurb: 'Which insects breached their critical limit, at which stations and when (the latest first), and each insect month by month in green, amber or red.', f: ['limMonths', 'breached', 'type', 'station', 'pest'] },
        { id: 'recs', icon: '📋', title: 'Recommendations', blurb: 'Raised and completed, by type, and how long they took.', f: ['period'] },
        { id: 'visits', icon: '🗓️', title: 'Service visits', blurb: 'Visits each month, the technician and the time on site.', f: ['period', 'tech'] }
    ];
    const PRESETS = [['30d', 'Last 30 days'], ['3m', 'Last 3 months'], ['12m', 'Last 12 months'], ['ytd', 'This year'], ['ly', 'Last year'], ['all', 'All time'], ['custom', 'Choose dates']];
    function range(s) {
        const now = new Date(), end = Date.now() + 60000;
        if (s.preset === '30d') return [end - 30 * DAY, end];
        if (s.preset === '3m') return [new Date(now.getFullYear(), now.getMonth() - 2, 1).getTime(), end];
        if (s.preset === '12m') return [new Date(now.getFullYear(), now.getMonth() - 11, 1).getTime(), end];
        if (s.preset === 'ytd') return [new Date(now.getFullYear(), 0, 1).getTime(), end];
        if (s.preset === 'ly') return [new Date(now.getFullYear() - 1, 0, 1).getTime(), new Date(now.getFullYear(), 0, 1).getTime()];
        if (s.preset === 'custom') return [s.from ? Date.parse(s.from + 'T00:00:00') : 0, s.to ? Date.parse(s.to + 'T23:59:59') : end];
        return [0, end];
    }
    const rangeText = s => { const [a, b] = range(s); return s.preset === 'all' ? 'All time' : `${fmtD(a)} - ${fmtD(Math.min(b, Date.now()))}`; };
    const months = (a, b) => { const out = []; for (let k = monthKey(a); k <= monthKey(Math.min(b, Date.now())); k++) out.push(k); return out; };

    // ---------- small SVG charts ----------
    function lineChart(series, keys, opts) {
        opts = opts || {};
        const W = 760, H = 260, pl = opts.yLbl ? 64 : 40, pr = 12, pt = 14, pb = 34;
        const max = opts.max || Math.max(1, ...series.flatMap(s => s.vals).filter(v => v != null), opts.limit || 0);
        const n = keys.length, x = i => pl + (n <= 1 ? (W - pl - pr) / 2 : i * (W - pl - pr) / (n - 1)), y = v => pt + (H - pt - pb) * (1 - v / max);
        const ticks = opts.ticks || Array.from(new Set([0, .25, .5, .75, 1].map(f => Math.round(max * f))));
        const yl = v => opts.yLbl ? opts.yLbl(v) : v;
        // a line breaks only where there's no data yet (months not reached); nothing caught is drawn as 0
        const runs = vals => { const out = []; let cur = []; vals.forEach((v, i) => { if (v == null) { if (cur.length) out.push(cur); cur = []; } else cur.push(i); }); if (cur.length) out.push(cur); return out; };
        const every = Math.ceil(n / 12);
        return `<svg viewBox="0 0 ${W} ${H}" class="pr-svg" role="img" aria-label="${e(opts.label || 'Chart')}">
            ${ticks.map(t => `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" class="pr-grid"/><text x="${pl - 6}" y="${y(t) + 4}" text-anchor="end" class="pr-ax">${e(yl(t))}</text>`).join('')}
            ${keys.map((k, i) => (i % every === 0 && (i === n - 1 || n - 1 - i >= every * 0.75)) || i === n - 1 ? `<text x="${x(i)}" y="${H - 12}" text-anchor="${n > 1 && i === n - 1 ? 'end' : i === 0 && n > 1 ? 'start' : 'middle'}" class="pr-ax">${e(opts.lbl ? opts.lbl(k) : k)}</text>` : '').join('')}
            ${opts.limit != null ? `<line x1="${pl}" x2="${W - pr}" y1="${y(opts.limit)}" y2="${y(opts.limit)}" stroke="#dc2626" stroke-width="2" stroke-dasharray="6 5"/><text x="${W - pr}" y="${y(opts.limit) - 5}" text-anchor="end" class="pr-ax" fill="#dc2626">Limit ${opts.limit}</text>` : ''}
            ${series.map(s => runs(s.vals).map(r => `<polygon fill="${s.color}" fill-opacity="${series.length > 3 ? .06 : .14}" stroke="none" points="${r.map(i => `${x(i)},${y(s.vals[i])}`).join(' ')} ${x(r[r.length - 1])},${y(0)} ${x(r[0])},${y(0)}"/>`).join('')).join('')}
            ${series.map(s => runs(s.vals).map(r => `<polyline fill="none" stroke="${s.color}" stroke-width="${s.thin ? 1.8 : 2.5}" ${s.dash ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round" stroke-linecap="round" points="${r.map(i => `${x(i)},${y(s.vals[i])}`).join(' ')}"/>`).join('')
                + s.vals.map((v, i) => v == null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="${opts.limit != null && v > opts.limit ? 5 : 3.2}" fill="${opts.limit != null && v > opts.limit ? '#dc2626' : s.color}"><title>${e(s.name)} · ${e(opts.lbl ? opts.lbl(keys[i]) : keys[i])}: ${e(yl(v))}</title></circle>`).join('')).join('')}
        </svg>${series.length > 1 ? `<div class="pr-legend">${series.map(s => `<span><i style="background:${s.color}"></i>${e(s.name)}</span>`).join('')}</div>` : ''}`;
    }
    function barChart(rows, opts) {
        opts = opts || {};
        const max = Math.max(1, ...rows.map(r => r.v));
        return `<div class="pr-bars">${rows.map(r => `<div class="pr-bar-row"><span class="pr-bar-l" title="${e(r.l)}">${e(r.l)}</span><span class="pr-bar-t"><span class="pr-bar-f" style="width:${Math.max(1.5, r.v / max * 100)}%;background:${r.c || 'var(--pr-accent)'}"></span></span><span class="pr-bar-v">${e(opts.fmt ? opts.fmt(r.v) : r.v)}</span></div>`).join('') || '<div class="pr-empty">Nothing to show for this choice.</div>'}</div>`;
    }
    function colBars(vals, keys, opts) {
        opts = opts || {};
        const W = 760, H = 220, pl = 36, pb = 30, pt = 10, n = keys.length, max = Math.max(1, ...vals), bw = (W - pl - 8) / Math.max(1, n);
        const every = Math.ceil(n / 12);
        return `<svg viewBox="0 0 ${W} ${H}" class="pr-svg" role="img" aria-label="${e(opts.label || 'Chart')}">
            ${[0, .5, 1].map(f => { const v = Math.round(max * f), yy = pt + (H - pt - pb) * (1 - f); return `<line x1="${pl}" x2="${W - 8}" y1="${yy}" y2="${yy}" class="pr-grid"/><text x="${pl - 5}" y="${yy + 4}" text-anchor="end" class="pr-ax">${v}</text>`; }).join('')}
            ${vals.map((v, i) => { const h = (H - pt - pb) * v / max; return `<rect x="${pl + i * bw + 3}" y="${H - pb - h}" width="${Math.max(2, bw - 6)}" height="${h}" rx="3" fill="${opts.color || 'var(--pr-accent)'}"><title>${e(opts.lbl ? opts.lbl(keys[i]) : keys[i])}: ${v}</title></rect>${i % every === 0 ? `<text x="${pl + i * bw + bw / 2}" y="${H - 10}" text-anchor="middle" class="pr-ax">${e(opts.lbl ? opts.lbl(keys[i]) : keys[i])}</text>` : ''}`; }).join('')}
        </svg>`;
    }
    const table = (head, rows, opts) => `<div class="pr-tbl-wrap"><table class="pr-tbl"><thead><tr>${head.map(h => `<th class="${h.num ? 'num' : ''}">${e(h.t)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(r => `<tr${r._cls ? ` class="${r._cls}"` : ''}>${r.cells.map((c, i) => `<td class="${head[i] && head[i].num ? 'num' : ''}">${c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${head.length}" class="pr-empty">${e((opts && opts.empty) || 'No records for this choice.')}</td></tr>`}</tbody></table></div>`;
    const kpis = list => `<div class="pr-kpis">${list.map(k => `<div class="pr-kpi"><div class="pr-kpi-v" ${k.c ? `style="color:${k.c}"` : ''}>${e(k.v)}</div><div class="pr-kpi-l">${e(k.l)}</div></div>`).join('')}</div>`;

    // ---------- state and drawing ----------
    const ST = new WeakMap();
    function render(box, data, opts) {
        opts = opts || {};
        let s = ST.get(box);
        if (!s) { s = { report: null, view: 'time', years: '2', preset: '12m', from: '', to: '', type: '', pest: '', station: '', map: '', prep: '', batch: '', tech: '', gap: '35', breached: 'yes', limFrom: monthKey(Date.now()), limTo: monthKey(Date.now()) }; ST.set(box, s); }
        box._pr = { data, opts };
        draw(box);
    }
    function set(btn, k, v) { const box = btn.closest('.pr-root').parentElement, s = ST.get(box); if (!s) return;
        if (k === 'report' && s._linked) { s.station = s._prevStation; s._linked = false; }   // back from a station opened by tapping its name: the other reports aren't left filtered to it
        if (k === 'station') s._linked = false;
        // a new station type: a station of another type is no longer chosen
        if (k === 'type' && s.station && v) { const d = box._pr && box._pr.data, st = d && d.stations.find(x => x.barcode === s.station); if (st && st.type !== v) s.station = ''; }
        s[k] = v; if (k === 'report') window.scrollTo && box.scrollIntoView && box.scrollIntoView({ block: 'start', behavior: 'smooth' }); draw(box); }
    function draw(box) {
        const s = ST.get(box), { data, opts } = box._pr;
        if (!s.report) {
            box.innerHTML = `<div class="pr-root"><div class="pr-head"><div><h3 class="pr-h">Reports</h3><p class="pr-sub">Pick a report. Each one has just the filters it needs, and every report can be downloaded for Excel or printed / saved as a PDF.</p></div></div>
                <div class="pr-pick">${REPORTS.map(r => `<button type="button" class="pr-card" onclick="PR.set(this, 'report', '${r.id}')"><span class="pr-card-i">${r.icon}</span><span><b>${e(r.title)}</b><span>${e(r.blurb)}</span></span></button>`).join('')}</div></div>`;
            return;
        }
        const R = REPORTS.find(r => r.id === s.report);
        // a report only uses the filters it shows (a station picked in one report doesn't quietly filter another)
        const sx = Object.assign({}, s, R.f.includes('type') ? {} : { type: '' }, R.f.includes('station') ? {} : { station: '' });
        const out = BUILD[R.id](data, sx, opts);
        if (R.id === 'station') s.station = sx.station;   // the station it settled on
        box._pr.csv = out.csv;
        box.innerHTML = `<div class="pr-root pr-print">
            <div class="pr-head"><button type="button" class="pr-back" onclick="PR.set(this, 'report', null)">‹ All reports</button>
                <div class="min-w-0"><h3 class="pr-h">${R.icon} ${e(R.title)}</h3><p class="pr-sub">${e(data.site)}${R.f.includes('period') ? ' · ' + e(rangeText(s)) : ''}</p></div>
                <div class="pr-acts"><button type="button" class="pr-btn" onclick="PR.download(this)">⬇ Download (Excel)</button><button type="button" class="pr-btn" onclick="PR.print(this)">🖨 Print / PDF</button></div></div>
            <div class="pr-filters">${filtersHtml(R, data, s)}</div>
            ${out.html}</div>`;
    }
    function opt(v, l, cur) { return `<option value="${e(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${e(l)}</option>`; }
    function filtersHtml(R, d, s) {
        const cmb = (k, label, list, all) => combo({ k, label, list: list.map(x => Array.isArray(x) ? x : [x, x]), cur: s[k], all, cb: 'PR.set' });
        const sel = (k, label, list, all) => `<label class="pr-f"><span>${e(label)}</span><select onchange="PR.set(this, '${k}', this.value)">${all ? opt('', all, s[k]) : ''}${list.map(x => Array.isArray(x) ? opt(x[0], x[1], s[k]) : opt(x, x, s[k])).join('')}</select></label>`;
        const uniq = a => Array.from(new Set(a.filter(Boolean))).sort((x, y) => String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }));
        const parts = [];
        R.f.forEach(f => {
            if (f === 'view') parts.push(sel('view', 'Show', [['time', 'Over time'], ['yoy', 'Year on year (each year on top of the last)']]));
            if (f === 'years' && (R.id === 'station' || s.view === 'yoy')) parts.push(sel('years', R.id === 'station' && s.view !== 'yoy' ? 'Over the last' : 'Years', [['1', 'This year'], ['2', '2 years'], ['3', '3 years'], ['5', '5 years'], ['all', 'All years']]));
            if (f === 'period' && R.f.includes('view') && s.view === 'yoy') return;
            if (f === 'period') {
                parts.push(sel('preset', 'Period', PRESETS));
                if (s.preset === 'custom') parts.push(`<label class="pr-f"><span>From</span><input type="date" value="${e(s.from)}" onchange="PR.set(this, 'from', this.value)"></label><label class="pr-f"><span>To</span><input type="date" value="${e(s.to)}" onchange="PR.set(this, 'to', this.value)"></label>`);
            }
            // critical limits are for insects only: just the flying and crawling insect types, stations and pests
            if (f === 'type') parts.push(sel('type', 'Station type', (d.types || uniq(d.stations.map(x => x.type))).filter(t => R.id !== 'limits' || isInsect(t)), R.id === 'limits' ? 'All insect stations' : 'All types'));
            if (f === 'pest' && R.id === 'limits') { parts.push(cmb('pest', 'Insect', uniq([].concat(...d.limits.map(l => l.rules.map(x => x.species)))), 'All insects')); return; }
            if (f === 'pest') { const st = R.id === 'station' ? d.stations.find(x => x.barcode === s.station) : null; if (!(st && isActivity(st))) parts.push(cmb('pest', 'Pest', st ? uniq(st.entries.map(x => x.species)) : uniq(d.species || d.entries.map(x => x.species)), 'All pests')); }
            if (f === 'map') parts.push(cmb('map', 'Floor plan', uniq(d.stations.map(x => x.map)), 'All floor plans'));
            if (f === 'prep') parts.push(cmb('prep', 'Preparation', uniq(d.entries.map(x => x.prep)), 'All preparations'));
            if (f === 'tech') parts.push(sel('tech', 'Technician', uniq(d.visits.map(x => x.tech).concat(d.entries.map(x => x.tech))), 'Everyone'));
            // the stations of the chosen type (type to search a long list)
            if (f === 'station') parts.push(cmb('station', s.type ? `Station (${s.type})` : 'Station', stationsOfType(d, s).filter(x => R.id !== 'limits' || isInsect(x.type)).map(x => [x.barcode, x.name + (x.type && !s.type ? ' · ' + x.type : '')]), R.id === 'station' ? null : (s.type ? 'All ' + s.type : 'All stations')));
            if (f === 'batch') parts.push(`<label class="pr-f"><span>Batch number</span><input type="search" value="${e(s.batch)}" placeholder="Any" onchange="PR.set(this, 'batch', this.value.trim())"></label>`);
            // critical limits: the months to look at (this month to start with; From and To for several months), and breached stations only or all
            if (f === 'limMonths') { const ms = months(Date.now() - 3 * 365 * DAY, Date.now()).reverse().map(k => [k, monthLong(k)]); parts.push(sel('limFrom', 'From', ms), sel('limTo', 'To', ms)); }
            if (f === 'breached') parts.push(sel('breached', 'Breached', [['yes', 'Yes - only stations that breached'], ['no', 'No - every station']]));
            if (f === 'gap') parts.push(sel('gap', 'Flag stations not scanned for', [['14', '2 weeks'], ['35', '5 weeks'], ['60', '2 months'], ['95', '3 months']]));
        });
        return parts.join('');
    }
    // the stations a report can pick from: those of the chosen station type
    const stationsOfType = (d, s) => d.stations.filter(x => !s.type || x.type === s.type);
    // the records a report looks at (the chosen station type, and station)
    function pick(d, s, extra) {
        const [a, b] = range(s);
        return d.entries.filter(x => x.at >= a && x.at <= b && (!s.type || x.type === s.type) && (!s.station || x.barcode === s.station) && (!extra || extra(x)));
    }
    const color = (opts, type) => (opts.colorOf ? opts.colorOf(type) : null) || '#64748b';
    const dot = (opts, type) => `<span class="pr-dot" style="background:${color(opts, type)}"></span>`;

    // external toxic (bait) stations are read by their activity: None, Low, Medium, High
    const LEVELS = ['None', 'Low', 'Medium', 'High'];
    const isActivity = st => /external/i.test(st.type || '') && /toxic|bait/i.test(st.type || '');
    // flying and crawling insect stations (critical limits are for insects, not rodents)
    const isInsect = t => /insect|fly|flies|flying|crawl|cockroach/i.test(t || '') && !/rodent|\brat|mouse|mice/i.test(t || '');
    const level = a => Math.max(0, LEVELS.indexOf(a));
    const levelOf = list => list.length ? Math.max(...list.map(x => level(x.activity))) : null;   // the highest that month
    const ACT_CHART = { max: 3, ticks: [0, 1, 2, 3], yLbl: v => LEVELS[v] || v };
    const MONTHS12 = Array.from({ length: 12 }, (_, i) => i);
    const monShort = i => new Date(2000, i, 1).toLocaleDateString(LOC, { month: 'short' });
    // the years a report covers (newest last)
    function yearsOf(s, d, list) {
        const now = new Date().getFullYear(), first = list && list.length ? new Date(list[0].at).getFullYear() : now;
        const n = s.years === 'all' ? Math.max(1, now - first + 1) : Math.max(1, Number(s.years) || 2);
        return Array.from({ length: n }, (_, i) => now - n + 1 + i);
    }
    const yearColor = (i, n) => i === n - 1 ? '#ea580c' : ['#2563eb', '#16a34a', '#9333ea', '#0891b2', '#ca8a04', '#db2777', '#64748b', '#94a3b8'][(n - 2 - i) % 8];
    // one line per year, January to December (months not reached yet are left off)
    function yoySeries(years, valOf) {
        const now = new Date();
        return years.map((yr, i) => ({ name: String(yr), color: yearColor(i, years.length), thin: i < years.length - 1,
            vals: MONTHS12.map(m => yr === now.getFullYear() && m > now.getMonth() ? null : valOf(yr, m)) }));
    }
    const inYM = (x, yr, m) => { const t = new Date(x.at); return t.getFullYear() === yr && t.getMonth() === m; };

    const BUILD = {
        trend(d, s) {
            if (s.view === 'yoy') {
                const list = d.entries.filter(x => x.species && (!s.type || x.type === s.type) && (!s.station || x.barcode === s.station) && (!s.pest || x.species === s.pest));
                const years = yearsOf(s, d, list);
                const series = yoySeries(years, (yr, m) => list.filter(x => inYM(x, yr, m)).reduce((n, x) => n + x.count, 0));
                const head = [{ t: 'Month' }].concat(years.map(yr => ({ t: String(yr), num: true })));
                return {
                    html: kpis(years.slice().reverse().slice(0, 3).map(yr => ({ v: list.filter(x => new Date(x.at).getFullYear() === yr).reduce((n, x) => n + x.count, 0), l: `${s.pest || 'captures'} in ${yr}${yr === new Date().getFullYear() ? ' so far' : ''}` })))
                        + `<div class="pr-chart"><div class="pr-cap">${e(s.pest || 'All pests')}: captures each month, one line per year</div>${lineChart(series, MONTHS12, { lbl: monShort, label: 'Captures per month, year on year' })}</div>`
                        + table(head, MONTHS12.map(m => ({ cells: [e(monShort(m))].concat(series.map(x => x.vals[m] == null ? '' : x.vals[m])) }))),
                    csv: [head.map(h => h.t)].concat(MONTHS12.map(m => [monShort(m)].concat(series.map(x => x.vals[m] == null ? '' : x.vals[m]))))
                };
            }
            const [a, b] = range(s), list = pick(d, s, x => x.species && (!s.pest || x.species === s.pest));
            const ks = months(a || (d.entries[0] ? d.entries[0].at : Date.now()), b);
            const tot = new Map(); list.forEach(x => tot.set(x.species, (tot.get(x.species) || 0) + x.count));
            const top = Array.from(tot.entries()).sort((p, q) => q[1] - p[1]);
            const named = top.slice(0, 6).map(p => p[0]), rest = top.slice(6).map(p => p[0]);
            const series = named.map((sp, i) => ({ name: sp, color: PALETTE[i], vals: ks.map(k => list.filter(x => x.species === sp && monthKey(x.at) === k).reduce((n, x) => n + x.count, 0)) }));
            if (rest.length) series.push({ name: `Other (${rest.length})`, color: PALETTE[8], vals: ks.map(k => list.filter(x => rest.includes(x.species) && monthKey(x.at) === k).reduce((n, x) => n + x.count, 0)) });
            const totals = ks.map(k => list.filter(x => monthKey(x.at) === k).reduce((n, x) => n + x.count, 0));
            const half = Math.floor(ks.length / 2), first = totals.slice(0, half).reduce((p, q) => p + q, 0), second = totals.slice(half).reduce((p, q) => p + q, 0);
            const dir = !first && !second ? 'No captures' : second > first * 1.15 ? 'Going up' : second < first * 0.85 ? 'Going down' : 'Steady';
            const head = [{ t: 'Month' }].concat(series.map(x => ({ t: x.name, num: true })), [{ t: 'Total', num: true }]);
            const rows = ks.map((k, i) => ({ cells: [e(monthLong(k))].concat(series.map(x => x.vals[i] || ''), [`<b>${totals[i]}</b>`]) })).reverse();
            return {
                html: kpis([{ v: list.reduce((n, x) => n + x.count, 0), l: 'captures' }, { v: tot.size, l: 'pests' }, { v: dir, l: 'trend (second half vs first)', c: dir === 'Going up' ? '#dc2626' : dir === 'Going down' ? '#16a34a' : '' }])
                    + `<div class="pr-chart">${lineChart(series.length ? series : [{ name: 'Pests caught', color: PALETTE[0], vals: ks.map(() => 0) }], ks, { lbl: monthLbl, label: series.length ? 'Captures per month' : 'Captures per month (no pests were caught in this period)' })}</div>` + table(head, rows),
                csv: [head.map(h => h.t)].concat(ks.map((k, i) => [monthLong(k)].concat(series.map(x => x.vals[i]), [totals[i]])))
            };
        },
        pests(d, s, opts) {
            const list = pick(d, s, x => x.species && (!s.station || x.barcode === s.station) && (!s.pest || x.species === s.pest));
            // each pest, and each station it was recorded on
            const tot = new Map(), by = new Map();
            list.forEach(x => {
                tot.set(x.species, (tot.get(x.species) || 0) + x.count);
                const k = x.species + '\u0000' + x.barcode, o = by.get(k) || { sp: x.species, st: x.stationObj, n: 0, times: 0, last: 0 };
                o.n += x.count; o.times++; o.last = Math.max(o.last, x.at); by.set(k, o);
            });
            const all = list.reduce((n, x) => n + x.count, 0);
            const pests = Array.from(tot.entries()).sort((p, q) => q[1] - p[1]);
            const rank = new Map(pests.map(([sp], i) => [sp, i]));
            const rows = Array.from(by.values()).sort((p, q) => rank.get(p.sp) - rank.get(q.sp) || q.n - p.n || p.st.name.localeCompare(q.st.name, undefined, { numeric: true }));
            const head = [{ t: 'Pest' }, { t: 'Station' }, { t: 'Station type' }, { t: 'Floor plan' }, { t: 'Captures', num: true }, { t: 'Times recorded', num: true }, { t: 'Last found' }];
            return {
                html: kpis([{ v: all, l: 'captures' }, { v: pests.length, l: 'different pests' }, { v: new Set(list.map(x => x.barcode)).size, l: 'stations with pests' }, { v: pests[0] ? pests[0][0] : '-', l: 'most common' }])
                    + `<div class="pr-chart">${barChart(pests.map(([sp, n], i) => ({ l: sp, v: n, c: PALETTE[i % 8] })))}</div>`
                    + table(head, rows.map(o => ({ cells: [e(o.sp), stLink(opts, o.st), e(o.st.type || ''), e(o.st.map || ''), o.n, o.times, e(fmtD(o.last))] })), { empty: 'No pests recorded for this choice.' }),
                csv: [head.map(h => h.t)].concat(rows.map(o => [o.sp, o.st.name, o.st.type || '', o.st.map || '', o.n, o.times, fmtD(o.last)]))
            };
        },
        stations(d, s, opts) {
            const list = pick(d, s, x => x.species && (!s.pest || x.species === s.pest));
            const by = new Map();
            list.forEach(x => { const o = by.get(x.barcode) || { st: x.stationObj, n: 0, recs: 0, last: 0, pests: new Map() }; o.n += x.count; o.recs++; o.last = Math.max(o.last, x.at); o.pests.set(x.species, (o.pests.get(x.species) || 0) + x.count); by.set(x.barcode, o); });
            const rows = Array.from(by.values()).sort((p, q) => q.n - p.n);
            const head = [{ t: 'Station' }, { t: 'Type' }, { t: 'Floor plan' }, { t: 'Captures', num: true }, { t: 'Times with pests', num: true }, { t: 'Main pest' }, { t: 'Last found' }];
            const main = o => Array.from(o.pests.entries()).sort((p, q) => q[1] - p[1])[0][0];
            return {
                html: kpis([{ v: rows.length, l: 'stations with pests' }, { v: list.reduce((n, x) => n + x.count, 0), l: 'captures' }, { v: rows[0] ? rows[0].st.name : '-', l: 'busiest station' }])
                    + `<div class="pr-chart">${barChart(rows.slice(0, 15).map(o => ({ l: o.st.name, v: o.n, c: color(opts, o.st.type) })))}${rows.length > 15 ? `<p class="pr-note">The top 15 are charted; all ${rows.length} are in the table.</p>` : ''}</div>`
                    + table(head, rows.map(o => ({ cells: [stLink(opts, o.st), e(o.st.type), e(o.st.map || '-'), o.n, o.recs, e(main(o)), e(fmtD(o.last))] }))),
                csv: [head.map(h => h.t)].concat(rows.map(o => [o.st.name, o.st.type, o.st.map, o.n, o.recs, main(o), fmtD(o.last)]))
            };
        },
        station(d, s, opts) {
            const ofType = stationsOfType(d, s);
            if (!s.station || !ofType.some(x => x.barcode === s.station)) s.station = ofType[0] ? ofType[0].barcode : '';
            if (!s.station) return { html: `<div class="pr-empty">${s.type ? `No ${e(s.type)} stations on this site.` : 'This site has no stations yet.'}</div>`, csv: [] };
            const stn = d.stations.find(x => x.barcode === s.station);
            if (!stn) return { html: '<div class="pr-empty">This site has no stations yet.</div>', csv: [] };
            const act = isActivity(stn);
            if (act || (s.pest && !stn.entries.some(x => x.species === s.pest))) s.pest = '';
            const years = yearsOf(s, d, stn.entries), from = new Date(years[0], 0, 1).getTime();
            const list = stn.entries.filter(x => x.at >= from);
            const caught = list.filter(x => x.species && (!s.pest || x.species === s.pest));
            let chart, cap;
            if (s.view === 'yoy') {
                const series = yoySeries(years, (yr, m) => { const inM = list.filter(x => inYM(x, yr, m)); return act ? (levelOf(inM) || 0) : caught.filter(x => inYM(x, yr, m)).reduce((n, x) => n + x.count, 0); });
                cap = act ? 'Activity each month (the highest found), one line per year' : `${s.pest || 'All pests'}: caught each month, one line per year`;
                chart = lineChart(series, MONTHS12, Object.assign({ lbl: monShort, label: cap }, act ? ACT_CHART : {}));
            } else {
                const ks = months(from, Date.now());
                if (act) {
                    cap = 'Activity each month (the highest found)';
                    chart = lineChart([{ name: 'Activity', color: color(opts, stn.type), vals: ks.map(k => levelOf(list.filter(x => monthKey(x.at) === k)) || 0) }], ks, Object.assign({ lbl: monthLbl, label: cap }, ACT_CHART));
                } else {
                    const tot = new Map(); caught.forEach(x => tot.set(x.species, (tot.get(x.species) || 0) + x.count));
                    const sp = Array.from(tot.entries()).sort((p, q) => q[1] - p[1]).map(p => p[0]);
                    const series = sp.slice(0, 8).map((name, i) => ({ name, color: PALETTE[i], vals: ks.map(k => caught.filter(x => x.species === name && monthKey(x.at) === k).reduce((n, x) => n + x.count, 0)) }));
                    if (sp.length > 8) series.push({ name: `Other (${sp.length - 8})`, color: PALETTE[8], vals: ks.map(k => caught.filter(x => sp.slice(8).includes(x.species) && monthKey(x.at) === k).reduce((n, x) => n + x.count, 0)) });
                    cap = series.length ? 'Caught each month, one line per pest' : 'Caught each month (nothing caught at this station in this time)';
                    chart = lineChart(series.length ? series : [{ name: s.pest || 'Pests caught', color: color(opts, stn.type), vals: ks.map(() => 0) }], ks, { lbl: monthLbl, label: cap });
                }
            }
            const head = [{ t: 'Date' }, { t: 'Activity' }, { t: 'Pest' }, { t: 'Number', num: true }, { t: 'Preparation' }, { t: 'Batch' }, { t: 'Technician' }, { t: 'Notes' }];
            const rows = list.slice().reverse();
            const mapBtn = stn.map && opts.onMap ? `<button type="button" class="pr-btn pr-map-btn" data-b="${e(stn.barcode)}" onclick="PR.mapGo(this, this.dataset.b)">📍 Show on floor plan</button>` : '';
            return {
                html: `<div class="pr-station"><span>${dot(opts, stn.type)}<b>${e(stn.name)}</b> <span>${e(stn.type)}${stn.map ? ' · 📍 ' + e(stn.map) : ''} · ${e(stn.barcode)}</span></span>${mapBtn}</div>`
                    + kpis([{ v: list.length, l: 'checks' }, act ? { v: list.length ? LEVELS[levelOf(list)] : '-', l: 'highest activity' } : { v: caught.reduce((n, x) => n + x.count, 0), l: s.pest ? s.pest + ' caught' : 'caught' }, { v: stn.lastAt ? fmtDTS(stn.lastAt) : 'Never', l: 'last scanned' }])
                    + `<div class="pr-chart"><div class="pr-cap">${e(cap)}</div>${chart}</div>`
                    + table(head, rows.map(x => ({ cells: [e(fmtDT(x.at)), e(x.activity), e(x.species || '-'), x.count || '', prepLink(opts, x.prep || '') + (x.qty != null ? ` <span class="pr-faint">${e(x.qty)} ${e(x.unit)}</span>` : ''), `<span class="pr-mono">${e(x.batch)}</span>`, e(x.tech), e(x.notes)] }))),
                csv: [head.map(h => h.t)].concat(rows.map(x => [fmtDT(x.at), x.activity, x.species, x.count || '', x.prep, x.batch, x.tech, x.notes]))
            };
        },
        scanned(d, s, opts) {
            const gap = Number(s.gap) || 35, now = Date.now();
            const list = d.stations.filter(x => (!s.type || x.type === s.type) && (!s.station || x.barcode === s.station) && (!s.map || x.map === s.map))
                .map(x => Object.assign({ days: x.lastAt ? Math.floor((now - x.lastAt) / DAY) : null }, { x })).sort((p, q) => (q.days == null ? 1e9 : q.days) - (p.days == null ? 1e9 : p.days));
            const late = list.filter(o => o.days == null || o.days > gap);
            const head = [{ t: 'Station' }, { t: 'Type' }, { t: 'Floor plan' }, { t: 'Last scanned' }, { t: 'Days ago', num: true }, { t: 'Last result' }, { t: 'By' }];
            return {
                html: kpis([{ v: list.length, l: 'stations' }, { v: list.length - late.length, l: `scanned in the last ${gap} days`, c: '#16a34a' }, { v: late.length, l: 'not scanned for longer', c: late.length ? '#dc2626' : '' }])
                    + table(head, list.map(o => ({ _cls: o.days == null || o.days > gap ? 'pr-late' : '', cells: [stLink(opts, o.x), e(o.x.type), e(o.x.map || '-'), e(o.x.lastAt ? fmtDTS(o.x.lastAt) : 'Never'), o.days == null ? '-' : o.days, e(o.x.last ? (o.x.last.species ? `${o.x.last.species}${o.x.last.count ? ' ×' + o.x.last.count : ''}` : o.x.last.activity === 'None' ? 'No activity' : o.x.last.activity) : '-'), e(o.x.last ? o.x.last.tech : '')] }))),
                csv: [head.map(h => h.t)].concat(list.map(o => [o.x.name, o.x.type, o.x.map, o.x.lastAt ? fmtDTS(o.x.lastAt) : 'Never', o.days == null ? '' : o.days, o.x.last ? (o.x.last.species || o.x.last.activity) : '', o.x.last ? o.x.last.tech : '']))
            };
        },
        preps(d, s, opts) {
            const q = String(s.batch || '').toLowerCase();
            const list = pick(d, s, x => x.prep && (!s.prep || x.prep === s.prep) && (!s.station || x.barcode === s.station) && (!q || String(x.batch).toLowerCase().includes(q))).reverse();
            const byPrep = new Map();
            list.forEach(x => { const k = x.prep + '|' + x.unit; const o = byPrep.get(k) || { prep: x.prep, unit: x.unit, qty: 0, n: 0, batches: new Set(), stations: new Set() }; o.qty += x.qty || 0; o.n++; if (x.batch) o.batches.add(x.batch); o.stations.add(x.barcode); byPrep.set(k, o); });
            const sums = Array.from(byPrep.values()).sort((p, q2) => q2.n - p.n);
            const head = [{ t: 'Date' }, { t: 'Station' }, { t: 'Preparation' }, { t: 'Batch' }, { t: 'Amount', num: true }, { t: 'Technician' }];
            return {
                html: kpis([{ v: list.length, l: 'times used' }, { v: sums.length, l: 'preparations' }, { v: new Set(list.map(x => x.batch).filter(Boolean)).size, l: 'batch numbers' }])
                    + `<div class="pr-sum">${table([{ t: 'Preparation' }, { t: 'Times used', num: true }, { t: 'Total used', num: true }, { t: 'Stations', num: true }, { t: 'Batches' }], sums.map(o => ({ cells: [prepLink(opts, o.prep, true), o.n, `${Math.round(o.qty * 100) / 100} ${e(o.unit)}`, o.stations.size, `<span class="pr-mono">${e(Array.from(o.batches).join(', ') || '-')}</span>`] })), { empty: 'No preparations were used in this period.' })}</div>`
                    + table(head, list.map(x => ({ cells: [e(fmtDT(x.at)), stLink(opts, x.stationObj), prepLink(opts, x.prep), `<span class="pr-mono">${e(x.batch || '-')}</span>`, x.qty != null ? `${e(x.qty)} ${e(x.unit)}` : '', e(x.tech)] })), { empty: 'No preparations were used in this period.' }),
                csv: [head.map(h => h.t)].concat(list.map(x => [fmtDT(x.at), x.station, x.prep, x.batch, x.qty != null ? x.qty : '', x.unit, x.tech]))
            };
        },
        // Critical limits, station by station and insect by insect, for the months chosen (this month to start with).
        // A limit applies to EACH station linked to it: a station is judged only on its own catches that month.
        // red = this station caught more than its limit, amber = within 10% of it, green = under.
        // "Breached: Yes" (to start with) shows only the stations that breached, the latest breach first.
        limits(d, s, opts) {
            if (!d.limits.length) return { html: '<div class="pr-empty">No critical limits are set for this site.</div>', csv: [] };
            const now = monthKey(Date.now());
            let a = Number(s.limFrom) || now, b = Number(s.limTo) || now; if (a > b) [a, b] = [b, a];
            const pickedN = b - a + 1;
            // the graphs show at least 12 months, ending with the last month chosen
            const g0 = Math.min(a, b - 11), ks = Array.from({ length: b - g0 + 1 }, (_, i) => g0 + i);
            const inPick = mk => mk >= a && mk <= b;
            const when = a === b ? monthLong(a) : `${monthLong(a)} - ${monthLong(b)}`;
            const limById = new Map(d.limits.map(l => [String(l.id), l]));
            const stCount = (st, rule, mk) => d.entries.filter(x => x.barcode === st.barcode && monthKey(x.at) === mk && pestKey(x.species) === pestKey(rule.species)).reduce((n, x) => n + x.count, 0);
            // one insect at one station in one month: this station's catch against its limit
            const monthOf = (st, rule, mk) => {
                const mine = stCount(st, rule, mk);
                const status = mine > rule.max ? 'red' : rule.max > 0 && mine >= rule.max * .9 ? 'amber' : 'green';
                return { mk, mine, status };
            };
            const RANK = { red: 0, amber: 1, green: 2 };
            const COL = { red: '#dc2626', amber: '#d97706', green: '#16a34a' }, WORD = { red: 'Over the limit', amber: 'Close to the limit', green: 'Under the limit' };
            const worst = list => list.reduce((w, h) => RANK[h.status] < RANK[w] ? h.status : w, 'green');
            const typeOk = s.type && isInsect(s.type) ? s.type : '';
            const onlyBreached = s.breached !== 'no';
            const stations = d.stations.filter(st => limById.has(String(st.limitId)) && isInsect(st.type) && (!typeOk || st.type === typeOk) && (!s.station || st.barcode === s.station));
            // each station, and each insect on its limit (the worst first)
            let rows = stations.map(st => {
                const l = limById.get(String(st.limitId));
                const pests = l.rules.filter(rule => !s.pest || pestKey(rule.species) === pestKey(s.pest)).map(rule => {
                    const hist = ks.map(mk => monthOf(st, rule, mk)), picked = hist.filter(h => inPick(h.mk));
                    const over = picked.filter(h => h.status === 'red'), last = over.length ? over[over.length - 1] : null;
                    // the month to show the numbers for: the latest breach, else the latest month chosen
                    const show = last || picked[picked.length - 1];
                    return { rule, hist, over, last, show, status: worst(picked), total: picked.reduce((n, h) => n + h.mine, 0), year: hist.reduce((n, h) => n + h.mine, 0) };
                }).sort((p, q) => RANK[p.status] - RANK[q.status] || (q.last ? q.last.mk : -1) - (p.last ? p.last.mk : -1) || q.show.mine / (q.rule.max || 1) - p.show.mine / (p.rule.max || 1) || q.total - p.total);
                const lastMk = Math.max(-1, ...pests.map(p => p.last ? p.last.mk : -1));
                return { st, l, pests, status: worst(pests), lastMk, breaches: pests.reduce((n, p) => n + p.over.length, 0), total: pests.reduce((n, p) => n + p.total, 0) };
            }).filter(r => r.pests.length);
            const onLimit = rows.length;
            if (onlyBreached) rows = rows.filter(r => r.lastMk >= 0);
            // the latest breach first, then the rest by how they stood
            rows.sort((p, q) => q.lastMk - p.lastMk || RANK[p.status] - RANK[q.status] || q.breaches - p.breaches || q.total - p.total);
            // the graph for one insect at one station: its catch each month (coloured by how it stood against its limit)
            // and the limit (red dashes); the months chosen are shaded
            const chart = (r, p) => {
                const W = 760, H = 190, pl = 40, pr = 12, pt = 14, pb = 32, n = ks.length;
                const max = Math.max(1, p.rule.max, ...p.hist.map(h => h.mine));
                const x = i => pl + (n <= 1 ? (W - pl - pr) / 2 : i * (W - pl - pr) / (n - 1)), y = v => pt + (H - pt - pb) * (1 - v / max);
                const ticks = Array.from(new Set([0, .5, 1].map(f => Math.round(max * f))));
                const every = Math.ceil(n / 12), half = n <= 1 ? 0 : (W - pl - pr) / (n - 1) / 2;
                const bx0 = Math.max(pl, x(ks.indexOf(a)) - half), bx1 = Math.min(W - pr, x(ks.indexOf(b)) + half);
                return `<svg viewBox="0 0 ${W} ${H}" class="pr-svg" role="img" aria-label="${e(r.st.name)}: ${e(p.rule.species)} caught each month">
                    <rect x="${bx0}" y="${pt}" width="${Math.max(0, bx1 - bx0)}" height="${H - pt - pb}" fill="#94a3b8" fill-opacity=".12"/>
                    ${ticks.map(t => `<line x1="${pl}" x2="${W - pr}" y1="${y(t)}" y2="${y(t)}" class="pr-grid"/><text x="${pl - 6}" y="${y(t) + 4}" text-anchor="end" class="pr-ax">${t}</text>`).join('')}
                    ${ks.map((mk, i) => i % every === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 10}" text-anchor="${i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle'}" class="pr-ax">${e(monthLbl(mk))}</text>` : '').join('')}
                    ${p.rule.max > 0 ? `<line x1="${pl}" x2="${W - pr}" y1="${y(p.rule.max)}" y2="${y(p.rule.max)}" stroke="#dc2626" stroke-width="2" stroke-dasharray="7 5"/><text x="${W - pr}" y="${y(p.rule.max) - 5}" text-anchor="end" class="pr-ax" fill="#dc2626">Limit ${p.rule.max}</text>` : ''}
                    ${p.hist.slice(1).map((h, i) => `<polygon points="${x(i)},${y(p.hist[i].mine)} ${x(i + 1)},${y(h.mine)} ${x(i + 1)},${y(0)} ${x(i)},${y(0)}" fill="${COL[h.status]}" fill-opacity=".2" stroke="none"/>`).join('')}
                    ${p.hist.slice(1).map((h, i) => `<line x1="${x(i)}" y1="${y(p.hist[i].mine)}" x2="${x(i + 1)}" y2="${y(h.mine)}" stroke="${COL[h.status]}" stroke-width="3" stroke-linecap="round"/>`).join('')}
                    ${p.hist.map((h, i) => `<circle cx="${x(i)}" cy="${y(h.mine)}" r="${h.status === 'green' ? 3.5 : 5.5}" fill="${COL[h.status]}"><title>${e(monthLong(h.mk))} · ${e(p.rule.species)}: ${h.mine} caught here, limit ${p.rule.max} · ${WORD[h.status]}</title></circle>`).join('')}
                </svg>`;
            };
            const line = p => { const h = p.show;
                return `${e(monthLong(h.mk))}: <strong>${h.mine}</strong> caught here, this station's limit is <strong>${p.rule.max}</strong> a month${h.mine > p.rule.max ? ` (${h.mine - p.rule.max} over)` : ''}`
                    + (pickedN > 1 ? ` · over in ${p.over.length} of the ${pickedN} months chosen` : ''); };
            const pestHtml = (r, p) => `<div class="pr-lim-p ${p.status}"><div class="pr-lim-ph"><b>${e(p.rule.species)}</b><span class="pr-chip ${p.status}">${WORD[p.status]}</span></div>
                <div class="pr-lim-n">${line(p)}</div>${chart(r, p)}</div>`;
            const cards = rows.map(r => {
                const hot = r.pests.filter(p => p.status !== 'green');
                // insects over or close are open with their graph (or, when none are, those caught here this year);
                // the rest fold away (tap to see them)
                const open = hot.length ? hot : r.pests.filter(p => p.year > 0), calm = r.pests.filter(p => !open.includes(p));
                const fold = calm.length ? `<details class="pr-lim-more"><summary>${calm.length === 1 ? `${e(calm[0].rule.species)} is` : `${calm.length} ${open.length ? 'more ' : ''}insects are`} under the limit - show</summary>${calm.map(p => pestHtml(r, p)).join('')}</details>` : '';
                const nRed = hot.filter(p => p.status === 'red').length, nAmber = hot.length - nRed;
                const chip = r.status === 'green' ? 'All under the limit' : [nRed ? `${nRed} insect${nRed > 1 ? 's' : ''} over` : '', nAmber ? `${nAmber} close` : ''].filter(Boolean).join(' · ');
                return `<div class="pr-lim"><div class="pr-lim-h"><b>${stLink(opts, r.st)}</b><span class="pr-chip ${r.status}">${chip}</span></div>
                <p class="pr-note">${e(r.st.type || 'Station')} · critical limit: ${e(r.l.name)}${r.lastMk >= 0 ? ` · last breached <strong>${e(monthLong(r.lastMk))}</strong>` : ''}</p>
                ${open.length ? open.map(p => pestHtml(r, p)).join('') : `<p class="pr-note">None of these insects caught here in the last ${ks.length} months.</p>`}${fold}</div>`;
            }).join('');
            // the alert, insect by insect: the stations that went over their limit (or got close), and when
            const groups = new Map();
            rows.forEach(r => r.pests.forEach(p => { if (p.status === 'green') return;
                const key = pestKey(p.rule.species);
                if (!groups.has(key)) groups.set(key, { species: p.rule.species, status: p.status, over: [], near: [] });
                const g = groups.get(key); if (p.status === 'red') g.status = 'red';
                if (p.over.length) g.over.push({ st: r.st, max: p.rule.max, months: p.over.slice().reverse() }); else g.near.push({ st: r.st, max: p.rule.max, h: p.show });
            }));
            const lastOf = g => Math.max(-1, ...g.over.flatMap(o => o.months.map(h => h.mk)));
            const glist = Array.from(groups.values()).sort((p, q) => RANK[p.status] - RANK[q.status] || lastOf(q) - lastOf(p));
            const redN = glist.filter(g => g.status === 'red').length;
            const overTxt = o => `${stLink(opts, o.st)} (${o.months.map(h => `${e(monthLong(h.mk))}: ${h.mine} of ${o.max}`).join(', ')})`;
            const nearTxt = o => `${stLink(opts, o.st)} (${o.h.mine} of ${o.max})`;
            const alert = glist.length ? `<div class="pr-alert ${redN ? '' : 'pr-alert-amber'}"><b>${redN ? `⚠ ${breachedStsOf(rows)} over its critical limit in ${e(when)}` : `Getting close to a critical limit in ${e(when)}`}</b>
                ${glist.map(g => `<div class="pr-alert-g"><div>${g.status === 'red' ? '🔴' : '🟠'} <strong>${e(g.species)}</strong></div>
                    ${g.over.length ? `<div class="pr-alert-st">Over at: ${g.over.map(overTxt).join(', ')}</div>` : ''}${g.near.length ? `<div class="pr-alert-st">Close at: ${g.near.map(nearTxt).join(', ')}</div>` : ''}</div>`).join('')}</div>`
                : `<div class="pr-alert pr-alert-ok"><b>✓ Every station was within its critical limits in ${e(when)}.</b></div>`;
            function breachedStsOf(list) { const n = list.filter(r => r.lastMk >= 0).length; return n === 1 ? 'A station went' : n + ' stations went'; }
            const breaches = [];
            rows.forEach(r => r.pests.forEach(p => p.over.forEach(h => breaches.push({ mk: h.mk, r, p, h }))));
            const csv = [['Month', 'Station', 'Station type', 'Critical limit', 'Insect', 'Caught at this station', 'Station limit', 'Status']];
            rows.forEach(r => r.pests.forEach(p => p.hist.filter(h => inPick(h.mk)).forEach(h => csv.push([monthLong(h.mk), r.st.name, r.st.type, r.l.name, p.rule.species, h.mine, p.rule.max, WORD[h.status]]))));
            const breachedSts = rows.filter(r => r.lastMk >= 0).length;
            return {
                html: kpis([{ v: breachedSts, l: `stations that breached in ${when}`, c: breachedSts ? '#dc2626' : '#16a34a' }, { v: redN, l: 'insects over a station limit', c: redN ? '#dc2626' : '#16a34a' }, { v: breaches.length, l: 'breaches in these months' }, { v: onLimit, l: 'insect stations on a critical limit' }])
                    + alert
                    + `<div class="pr-legend"><span><i style="background:#16a34a"></i>Under the limit</span><span><i style="background:#d97706"></i>Within 10% of the limit</span><span><i style="background:#dc2626"></i>Over the limit</span><span><i class="pr-dash" style="border-color:#dc2626"></i>Limit</span><span><i style="background:rgba(148,163,184,.3)"></i>Months chosen</span></div>`
                    + `<div class="pr-lims">${cards || `<div class="pr-empty">${onlyBreached ? `No station breached a critical limit in ${e(when)}. 🎉 Choose more months, or Breached: No to see every station.` : 'No insect stations on a critical limit match these filters.'}</div>`}</div>`
                    + `<h4 class="pr-h4">Breaches by station</h4>` + table([{ t: 'Month' }, { t: 'Station' }, { t: 'Critical limit' }, { t: 'Insect' }, { t: 'Caught', num: true }, { t: 'Station limit', num: true }, { t: 'Over by', num: true }],
                        breaches.sort((p, q) => q.mk - p.mk).map(b => ({ _cls: 'pr-late', cells: [e(monthLong(b.mk)), stLink(opts, b.r.st), e(b.r.l.name), e(b.p.rule.species), b.h.mine, b.p.rule.max, b.h.mine - b.p.rule.max] })), { empty: `No breaches in ${e(when)} - every limit was kept. 🎉` }),
                csv
            };
        },
        recs(d, s, opts) {
            const [a, b] = range(s), list = d.recs.filter(r => r.raisedAt >= a && r.raisedAt <= b);
            const done = list.filter(r => r.status === 'complete' && r.completedAt);
            const avg = done.length ? Math.round(done.reduce((n, r) => n + (r.completedAt - r.raisedAt) / DAY, 0) / done.length) : null;
            const byCat = new Map(); list.forEach(r => byCat.set(r.category, (byCat.get(r.category) || 0) + 1));
            const ks = months(a || (list.length ? Math.min(...list.map(r => r.raisedAt)) : Date.now()), b);
            const head = [{ t: 'Number' }, { t: 'Raised' }, { t: 'Station' }, { t: 'Type' }, { t: 'Recommendation' }, { t: 'Status' }, { t: 'Days open', num: true }];
            const no = r => r.no != null ? 'R-' + String(r.no).padStart(4, '0') : '';
            const days = r => Math.max(0, Math.round(((r.completedAt || Date.now()) - r.raisedAt) / DAY));
            return {
                html: kpis([{ v: list.length, l: 'raised' }, { v: list.filter(r => r.status !== 'complete').length, l: 'still open or pending', c: '#ea580c' }, { v: done.length, l: 'completed', c: '#16a34a' }, { v: avg == null ? '-' : avg + ' days', l: 'average time to complete' }])
                    + `<div class="pr-two"><div class="pr-chart"><div class="pr-cap">Raised and completed each month</div>${lineChart([{ name: 'Raised', color: '#ea580c', vals: ks.map(k => list.filter(r => monthKey(r.raisedAt) === k).length) }, { name: 'Completed', color: '#16a34a', vals: ks.map(k => done.filter(r => monthKey(r.completedAt) === k).length) }], ks, { lbl: monthLbl, label: 'Recommendations raised and completed per month' })}</div><div class="pr-chart"><div class="pr-cap">By type</div>${barChart(Array.from(byCat.entries()).sort((p, q) => q[1] - p[1]).map(([c, n], i) => ({ l: c, v: n, c: PALETTE[i % 8] })))}</div></div>`
                    + table(head, list.slice().sort((p, q) => q.raisedAt - p.raisedAt).map(r => ({ cells: [opts.onRec && r.id ? `<button type="button" class="pr-link pr-mono" data-id="${e(r.id)}" onclick="PR.rec(this, this.dataset.id)" title="Open this recommendation">${e(no(r))}</button>` : `<span class="pr-mono">${e(no(r))}</span>`, e(fmtD(r.raisedAt)), e(r.station), e(r.category), e(r.text), `<span class="pr-chip ${r.status === 'complete' ? 'green' : r.status === 'pending' ? 'amber' : 'red'}">${e(r.status === 'complete' ? 'Complete' : r.status === 'pending' ? 'Pending' : 'Open')}</span>`, days(r)] }))),
                csv: [head.map(h => h.t)].concat(list.map(r => [no(r), fmtD(r.raisedAt), r.station, r.category, r.text, r.status, days(r)]))
            };
        },
        visits(d, s) {
            const [a, b] = range(s), list = d.visits.filter(v => v.at >= a && v.at <= b && (!s.tech || v.tech === s.tech));
            const ks = months(a || (list[0] ? list[0].at : Date.now()), b);
            const mins = v => v.start && v.end && v.end > v.start ? Math.round((v.end - v.start) / 60000) : null;
            const timed = list.map(mins).filter(x => x != null);
            const avg = timed.length ? Math.round(timed.reduce((p, q) => p + q, 0) / timed.length) : null;
            const hm = m => m == null ? '-' : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
            const byTech = new Map(); list.forEach(v => byTech.set(v.tech || 'Not recorded', (byTech.get(v.tech || 'Not recorded') || 0) + 1));
            const head = [{ t: 'Date' }, { t: 'Visit' }, { t: 'Technician' }, { t: 'Time on site', num: true }, { t: 'Stations checked', num: true }];
            return {
                html: kpis([{ v: list.length, l: 'visits' }, { v: hm(avg), l: 'average time on site' }, { v: byTech.size, l: 'technicians' }])
                    + `<div class="pr-two"><div class="pr-chart"><div class="pr-cap">Visits each month</div>${lineChart([{ name: 'Visits', color: '#7c3aed', vals: ks.map(k => list.filter(v => monthKey(v.at) === k).length) }], ks, { lbl: monthLbl, label: 'Visits per month' })}</div><div class="pr-chart"><div class="pr-cap">By technician</div>${barChart(Array.from(byTech.entries()).sort((p, q) => q[1] - p[1]).map(([t, n], i) => ({ l: t, v: n, c: PALETTE[i % 8] })))}</div></div>`
                    + table(head, list.slice().reverse().map(v => ({ cells: [e(fmtDT(v.at)), e(v.type), e(v.tech || '-'), e(hm(mins(v))), v.n] }))),
                csv: [head.map(h => h.t)].concat(list.map(v => [fmtDT(v.at), v.type, v.tech, mins(v) == null ? '' : mins(v), v.n]))
            };
        }
    };

    // ---------- download and print ----------
    function download(btn) {
        const box = btn.closest('.pr-root').parentElement, s = ST.get(box), rows = (box._pr && box._pr.csv) || [];
        const R = REPORTS.find(r => r.id === s.report);
        const cell = v => { const t = String(v == null ? '' : v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
        const csv = '﻿' + [[box._pr.data.site + ' - ' + R.title], [R.f.includes('period') ? rangeText(s) : ''], []].concat(rows).map(r => r.map(cell).join(',')).join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        a.download = `${box._pr.data.site || 'Site'} - ${R.title}.csv`.replace(/[\\/:*?"<>|]+/g, '-');
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
    function print(btn) {
        const root = btn.closest('.pr-root');
        document.body.classList.add('pr-printing');
        root.classList.add('pr-printing-this');
        const done = () => { document.body.classList.remove('pr-printing'); root.classList.remove('pr-printing-this'); window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        window.print();
        setTimeout(done, 1500);
    }
    // a station's name: its own report (or the app's station view when it has one)
    function station(btn, barcode) {
        const box = btn.closest('.pr-root').parentElement, s = ST.get(box);
        if (!s) return;
        const o = box._pr.opts || {};
        if (o.onStation) { o.onStation(barcode); return; }
        if (!s._linked) s._prevStation = s.station;
        s._linked = true; s.station = barcode; s.report = 'station';
        { const d = box._pr && box._pr.data, st = d && d.stations.find(x => x.barcode === barcode); if (st && s.type && st.type !== s.type) s.type = st.type; }
        box.scrollIntoView && box.scrollIntoView({ block: 'start', behavior: 'smooth' });
        draw(box);
    }
    // A drop-down you can type in: tap it, type part of a name, pick. cb(el, key, value) is called with the choice.
    function combo(o) {
        const items = (o.all != null ? [['', o.all]] : []).concat(o.list);
        const cur = items.find(x => String(x[0]) === String(o.cur == null ? '' : o.cur)) || items[0] || ['', ''];
        return `<label class="pr-f ${o.cls || ''}">${o.label ? `<span>${e(o.label)}</span>` : ''}<span class="pr-combo" data-k="${e(o.k)}" data-cb="${e(o.cb)}" data-items="${e(JSON.stringify(items))}">`
            + `<button type="button" class="pr-combo-btn" onclick="PR.comboOpen(this)" aria-haspopup="listbox" title="${e(cur[1])}">${e(cur[1])}</button></span></label>`;
    }
    function comboClose() { document.querySelectorAll('.pr-combo-pop').forEach(x => x.remove()); }
    function comboOpen(btn) {
        const wrap = btn.closest('.pr-combo'), had = wrap.querySelector('.pr-combo-pop');
        comboClose();
        if (had) return;
        const items = JSON.parse(wrap.dataset.items || '[]');
        const pop = document.createElement('div');
        pop.className = 'pr-combo-pop';
        pop.innerHTML = `<input type="search" class="pr-combo-q" placeholder="Type to search..." autocomplete="off" aria-label="Search"><div class="pr-combo-list" role="listbox"></div>`;
        wrap.appendChild(pop);
        const q = pop.querySelector('input'), box = pop.querySelector('.pr-combo-list');
        const draw = () => {
            const t = q.value.trim().toLowerCase();
            const hit = items.filter(x => !t || String(x[1]).toLowerCase().includes(t)).slice(0, 400);
            box.innerHTML = hit.map(x => `<button type="button" role="option" class="pr-combo-opt" data-v="${e(x[0])}">${e(x[1])}</button>`).join('') || '<div class="pr-combo-none">No matches</div>';
        };
        const pickV = v => {
            comboClose();
            const name = String(wrap.dataset.cb || ''), fn = name === 'PR.set' ? set : name.split('.').reduce((o, k) => o && o[k], window);   // PR itself isn't on window
            if (typeof fn === 'function') fn(btn, wrap.dataset.k, v);
        };
        box.addEventListener('click', ev => { const b = ev.target.closest('.pr-combo-opt'); if (b) pickV(b.dataset.v); });
        q.addEventListener('input', draw);
        q.addEventListener('keydown', ev => {
            if (ev.key === 'Escape') { comboClose(); btn.focus(); }
            if (ev.key === 'Enter') { ev.preventDefault(); const f = box.querySelector('.pr-combo-opt'); if (f) pickV(f.dataset.v); }
            if (ev.key === 'ArrowDown') { ev.preventDefault(); const f = box.querySelector('.pr-combo-opt'); if (f) f.focus(); }
        });
        box.addEventListener('keydown', ev => {
            const b = ev.target.closest('.pr-combo-opt'); if (!b) return;
            if (ev.key === 'ArrowDown') { ev.preventDefault(); (b.nextElementSibling || b).focus(); }
            if (ev.key === 'ArrowUp') { ev.preventDefault(); b.previousElementSibling ? b.previousElementSibling.focus() : q.focus(); }
            if (ev.key === 'Escape') { comboClose(); btn.focus(); }
        });
        draw();
        q.focus();
    }
    if (typeof document !== 'undefined') document.addEventListener('pointerdown', ev => { if (!ev.target.closest || !ev.target.closest('.pr-combo')) comboClose(); });
    function rec(btn, id) { const box = btn.closest('.pr-root').parentElement, o = (box._pr && box._pr.opts) || {}; if (o.onRec) o.onRec(id); }
    function mapGo(btn, barcode) { const box = btn.closest('.pr-root').parentElement, o = (box._pr && box._pr.opts) || {}; if (o.onMap) o.onMap(barcode); }
    function sds(btn, id) { const box = btn.closest('.pr-root').parentElement, o = (box._pr && box._pr.opts) || {}; if (o.openSds) o.openSds(id); }
    // open a report straight away, with some filters set (e.g. from a notification: the critical limits of one station)
    function show(box, report, patch) {
        const s = ST.get(box);
        if (!s || !box._pr) return;
        Object.assign(s, { report }, patch || {});
        draw(box);
    }
    return { build, render, set, download, print, station, sds, rec, mapGo, combo, comboOpen, comboClose, show, REPORTS };
})();
/* PESTIS-REPORTS:END */
