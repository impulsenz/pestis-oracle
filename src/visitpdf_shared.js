/* PESTIS-VISITPDF:BEGIN - the visit report PDF and the A4 pest map (identical in the Service App and the Client Portal; edit visitpdf_shared.js and run sync_visitpdf.py) */
// Each app turns its own visit into the plain description below, so the report is the same wherever it's downloaded:
//   { siteId, id (the visit's, if it has reached the server), siteName, address, completed, type, tech, start, end, inProgress, stationsChecked, services: [..], notes,
//     breaches: ['line', ..], entries: [{ name, barcode, type, activity, pests, prep, notes }],
//     recs: [{ id, no, status, raised, station, barcode, text, closed, note }],
//   Stations, recommendations and the visit link to the Client Portal.
//     signedBy, signedAt, noSignatureReason, signature (picture data URL or null), by (who downloaded it), app ('Service App' | 'Client Portal') }
// Times are milliseconds (or ISO text); text is already worded for the customer.
const PVR = (() => {
    const t = v => v == null || v === '' ? null : typeof v === 'number' ? v : Date.parse(v);
    const day = v => { const x = t(v); return x ? new Date(x).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
    const time = v => { const x = t(v); return x ? new Date(x).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' }) : '-'; };
    const dayTime = v => { const x = t(v); return x ? `${day(x)} ${time(x)}` : ''; };
    const dur = (a, b) => { const ms = t(b) - t(a); if (!t(a) || !t(b) || !(ms > 0)) return '-'; const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
    const safe = s => String(s || 'Site').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    const ENTRY_COLS = [['Station', 34], ['Barcode', 18], ['Type', 30], ['Activity', 16], ['Pests', 24], ['Preparation', 50], ['Notes', 50]];
    // where a station, recommendation or visit opens in the Client Portal (reports link back to it)
    const portalLink = (cid, kind, id) => cid == null || id == null ? null : `${location.origin}/client.html#/site/${encodeURIComponent(cid)}/${{ station: 'overview', rec: 'recs', visit: 'visits' }[kind]}/${kind}/${encodeURIComponent(id)}`;
    const REC_COLS = [['No.', 16], ['Status', 18], ['Raised', 20], ['Station', 30], ['Barcode', 18], ['Recommendation', 70], ['Closed', 20], ['Latest note', 50]];

    // the Pesties logo, made small enough for a PDF (loaded once)
    let logoP = null;
    function logo() {
        if (!logoP) logoP = new Promise(res => {
            const img = new Image();
            img.onload = () => {
                try {
                    const h = 300, w = Math.round(img.naturalWidth / img.naturalHeight * h), c = document.createElement('canvas');
                    c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
                    res({ url: c.toDataURL('image/png'), k: w / h, img: c });
                } catch (e) { res(null); }
            };
            img.onerror = () => res(null);
            img.src = 'images/pesties-logo.png';
        });
        return logoP;
    }

    // ---------- the Pest map: a floor plan with its stations, on one A4 page (the same from every app) ----------
    // a station pin: the same teardrop as on screen, its point on the spot
    function pin(g, x, y, r, color, overdue) {
        const cy = y - r * Math.SQRT2, a = Math.PI / 4;
        g.save();
        g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = r * .6; g.shadowOffsetY = r * .25;
        g.beginPath(); g.moveTo(x, y); g.arc(x, cy, r, Math.PI / 2 + a, Math.PI / 2 - a + 2 * Math.PI); g.closePath();
        g.fillStyle = color; g.fill();
        g.restore();
        g.beginPath(); g.moveTo(x, y); g.arc(x, cy, r, Math.PI / 2 + a, Math.PI / 2 - a + 2 * Math.PI); g.closePath();
        g.lineWidth = Math.max(2, r * .2); g.strokeStyle = '#fff'; g.stroke();
        if (overdue) { g.beginPath(); g.arc(x, cy, r * 1.45, 0, Math.PI * 2); g.lineWidth = Math.max(2, r * .28); g.strokeStyle = '#dc2626'; g.stroke(); }
    }
    // d = { image (an <img> or canvas of the plan), pins: [{ x, y (shares of the plan), name, type, color, overdue }], labels,
    //       types: [{ type, color }] (every station type, so the legend always shows them all), siteName, address, planName, madeBy, created, updated, by, app }
    // One A4 page: the navy header with the site and the Pesties logo, the plan as big as the page allows, then the legend
    // (every station type, "Floor plan not to scale") and the map details in a card along the bottom.
    // the plan without the blank (white) border around it, so the plan itself fills the page; pins are moved to match
    function trimmed(img, pins) {
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        try {
            const k = Math.min(1, 600 / Math.max(iw, ih)), w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
            const t = document.createElement('canvas'); t.width = w; t.height = h;
            const tg = t.getContext('2d'); tg.fillStyle = '#fff'; tg.fillRect(0, 0, w, h); tg.drawImage(img, 0, 0, w, h);
            const px = tg.getImageData(0, 0, w, h).data, blank = i => px[i] > 244 && px[i + 1] > 244 && px[i + 2] > 244;
            let x0 = w, y0 = h, x1 = -1, y1 = -1;
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!blank((y * w + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
            // keep every pin inside, and a little space round the edge
            pins.forEach(p => { const x = p.x * w, y = p.y * h; x0 = Math.min(x0, x - 3); x1 = Math.max(x1, x + 3); y0 = Math.min(y0, y - 6); y1 = Math.max(y1, y + 2); });
            if (x1 < 0) return { img, iw, ih, pins };
            const pad = Math.round(Math.max(w, h) * .015);
            x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad)); x1 = Math.min(w, Math.ceil(x1 + pad)); y1 = Math.min(h, Math.ceil(y1 + pad));
            if ((x1 - x0) * (y1 - y0) > w * h * .96) return { img, iw, ih, pins };   // nothing worth trimming
            const sx = x0 / k, sy = y0 / k, sw = (x1 - x0) / k, sh = (y1 - y0) / k;
            const c = document.createElement('canvas'); c.width = Math.round(sw); c.height = Math.round(sh);
            const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
            return { img: c, iw: c.width, ih: c.height, pins: pins.map(p => Object.assign({}, p, { x: (p.x * iw - sx) / sw, y: (p.y * ih - sy) / sh })) };
        } catch (e) { return { img, iw, ih, pins }; }   // a picture that can't be read: as it is
    }
    // The page itself (a canvas): d as for pestMap; with noPins the pins and names are left off (the Client Portal puts tappable
    // pins on top instead). Returns { canvas, W, H, box: { x, y, w, h } (where the plan is on the page), pins (placed in that box) }.
    async function pestMapPage(d, noPins) {
        const tr = trimmed(d.image, d.pins), iw = tr.iw, ih = tr.ih, pins = tr.pins;
        const land = iw >= ih;
        const W = land ? 3508 : 2480, H = land ? 2480 : 3508;   // A4 at 300 dpi
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d');
        const M = 70, gap = 40;   // a slim page margin, so the plan gets the room
        const font = (w, px) => `${w} ${px}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif`;
        const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
        const fit = (t, max) => { t = String(t); if (g.measureText(t).width <= max) return t; while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1); return t + '…'; };
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
        // the legend: every station type, and how many are on this plan
        const count = new Map(); pins.forEach(x => count.set(x.type, (count.get(x.type) || 0) + 1));
        const all = (d.types || []).slice();
        pins.forEach(x => { if (!all.some(t => t.type === x.type)) all.push({ type: x.type, color: x.color }); });
        const legItems = all.map(t => ({ t: t.type, n: count.get(t.type) || 0, color: t.color }));
        const details = [['Client', d.siteName || '-'], ['Site address', d.address || '-'], ['Floor plan', d.planName || '-'], ['Stations on this plan', String(pins.length)],
            ['Map made by', d.madeBy || 'Pesties'], ['Last updated', day(d.updated || d.created) || '-']];
        // a compact card: tight rows, more columns, so the plan gets the space
        const legCols = 3, rowH = 46, legRows = Math.ceil(legItems.length / legCols);
        const dCols = land ? 3 : 2, dRowH = 64, dRows = Math.ceil(details.length / dCols);
        const legH = 96 + Math.max(legRows * rowH, dRows * dRowH) + 18;
        // header: navy, an orange line under it, the Pesties logo on the right
        const headH = 240, HM = M + 20;
        const grd = g.createLinearGradient(0, 0, W, headH); grd.addColorStop(0, '#08112a'); grd.addColorStop(.6, '#0f1d42'); grd.addColorStop(1, '#1a2c5c');
        g.fillStyle = grd; g.fillRect(0, 0, W, headH);
        const glow = g.createRadialGradient(W * .78, -headH * .4, 0, W * .78, -headH * .4, W * .45); glow.addColorStop(0, 'rgba(249,115,22,.22)'); glow.addColorStop(1, 'rgba(249,115,22,0)');
        g.fillStyle = glow; g.fillRect(0, 0, W, headH);
        const bar = g.createLinearGradient(0, 0, W, 0); bar.addColorStop(0, '#f97316'); bar.addColorStop(1, '#fb923c');
        g.fillStyle = bar; g.fillRect(0, headH - 8, W, 8);
        const lg = await logo();
        let logoW = 0;
        if (lg) { const lh = 168, lw = lh * lg.k; logoW = lw + 60; g.drawImage(lg.img, W - HM - lw, (headH - 8 - lh) / 2, lw, lh); }
        g.textBaseline = 'alphabetic';
        g.fillStyle = '#fb923c'; g.font = font(800, 36); if ('letterSpacing' in g) g.letterSpacing = '6px'; g.fillText('PEST MAP', HM, 72); if ('letterSpacing' in g) g.letterSpacing = '0px';
        g.fillStyle = '#ffffff'; g.font = font(900, 77); g.fillText(fit(d.siteName || 'Site', W - HM * 2 - logoW), HM, 156);
        g.fillStyle = '#a9bbdc'; g.font = font(600, 38); g.fillText(fit(`${d.planName || 'Floor plan'}${d.address ? '  ·  ' + d.address : ''}`, W - HM * 2 - logoW), HM, 210);
        // the plan: as big as the space between the header and the legend allows (keeping its shape), centred
        const top = headH + gap, bottom = H - M - legH - gap, boxW = W - M * 2, boxH = bottom - top;
        const k = Math.min(boxW / iw, boxH / ih), mw = iw * k, mh = ih * k, mx = M + (boxW - mw) / 2, my = top + (boxH - mh) / 2;
        g.drawImage(tr.img, mx, my, mw, mh);
        const r = Math.max(15, Math.min(36, Math.min(mw, mh) / 50));
        if (!noPins) pins.forEach(x => pin(g, mx + x.x * mw, my + x.y * mh, r, x.color, x.overdue));
        if (d.labels && !noPins) {
            g.font = font(700, Math.round(r * 1.15)); g.textBaseline = 'middle';
            pins.forEach(x => {
                const px = mx + x.x * mw + r * 1.3, py = my + x.y * mh - r * Math.SQRT2, tw = g.measureText(x.name).width;
                // the name in the pin's colour, with a white edge so it reads on any plan
                g.lineJoin = 'round'; g.lineWidth = Math.max(3, r * .4); g.strokeStyle = '#fff'; g.strokeText(x.name, px + r * .2, py);
                g.fillStyle = x.color || '#0f172a'; g.fillText(x.name, px + r * .2, py);
            });
            g.textBaseline = 'alphabetic';
        }
        // the legend and map details card along the bottom
        const LW = W - M * 2, ly = H - M - legH, splitX = M + LW * (land ? .64 : .6);
        g.save(); g.shadowColor = 'rgba(15,23,42,.10)'; g.shadowBlur = 30; g.shadowOffsetY = 8; g.fillStyle = '#ffffff'; rr(M, ly, LW, legH, 28); g.fill(); g.restore();
        g.strokeStyle = '#e8edf4'; g.lineWidth = 3; rr(M, ly, LW, legH, 28); g.stroke();
        g.fillStyle = '#f97316'; rr(M, ly + 30, 8, 36, 4); g.fill();
        const head = (t, x) => { g.fillStyle = '#0f1d42'; g.font = font(800, 25); if ('letterSpacing' in g) g.letterSpacing = '4px'; g.fillText(t, x, ly + 58); if ('letterSpacing' in g) g.letterSpacing = '0px'; };
        head('LEGEND', M + 40); head('MAP DETAILS', splitX + 40);
        g.fillStyle = '#94a3b8'; g.font = font(600, 21); g.textAlign = 'right'; g.fillText('Floor plan not to scale', splitX - 36, ly + 58); g.textAlign = 'left';
        g.strokeStyle = '#eef2f7'; g.lineWidth = 3; g.beginPath(); g.moveTo(splitX, ly + 30); g.lineTo(splitX, ly + legH - 30); g.stroke();
        const lcW = (splitX - M - 64) / legCols;
        legItems.forEach((it, i) => {
            const x = M + 40 + (i % legCols) * lcW, y = ly + 112 + Math.floor(i / legCols) * rowH;
            pin(g, x + 14, y + 6, 12, it.color, false);
            g.fillStyle = it.n ? '#0b1530' : '#94a3b8'; g.font = font(700, 22); g.fillText(fit(it.t, lcW - 110), x + 40, y);
            const nt = it.n ? String(it.n) : '-'; g.font = font(800, 20); const pw = Math.max(40, g.measureText(nt).width + 24);
            g.fillStyle = it.n ? '#fff1e6' : '#f1f5f9'; rr(x + lcW - 24 - pw, y - 24, pw, 32, 16); g.fill();
            g.fillStyle = it.n ? '#c2410c' : '#94a3b8'; g.textAlign = 'center'; g.fillText(nt, x + lcW - 24 - pw / 2, y - 1); g.textAlign = 'left';
        });
        const dW = (M + LW - splitX - 72) / dCols;
        details.forEach(([key, val], i) => {
            const x = splitX + 40 + (i % dCols) * dW, y = ly + 104 + Math.floor(i / dCols) * dRowH;
            g.fillStyle = '#94a3b8'; g.font = font(800, 17); if ('letterSpacing' in g) g.letterSpacing = '2px'; g.fillText(key.toUpperCase(), x, y); if ('letterSpacing' in g) g.letterSpacing = '0px';
            g.fillStyle = '#0b1530'; g.font = font(700, 25); g.fillText(fit(val, dW - 16), x, y + 31);
        });
        return { canvas: c, W, H, land, box: { x: mx, y: my, w: mw, h: mh }, pins };
    }
    async function pestMap(d) {
        const { jsPDF } = window.jspdf;
        const { canvas: c, land } = await pestMapPage(d);
        // one A4 page, edge to edge
        const doc = new jsPDF({ orientation: land ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
        doc.addImage(c.toDataURL('image/jpeg', .92), 'JPEG', 0, 0, doc.internal.pageSize.getWidth(), doc.internal.pageSize.getHeight());
        doc.save(`${safe(d.siteName)} - ${safe(d.planName)} - Pest map.pdf`);
        return c;
    }
    async function build(v) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 12;
        const lg = await logo();
        let y = 0;
        const title = v.inProgress ? 'Visit report (in progress)' : 'Visit report';
        const sub = `${day(v.completed)} · ${v.type || 'Visit'}${v.tech ? ' · ' + v.tech : ''}`;
        const header = () => {
            doc.setFillColor(15, 23, 42); doc.rect(0, 0, W, 18, 'F');
            doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
            doc.text(`${v.siteName || 'Site'} · ${title}`, M, 11.5);
            // the Pesties logo in the top right corner (the name if it can't be loaded)
            if (lg) { const h = 13, w = h * lg.k; try { doc.addImage(lg.url, 'PNG', W - M - w, 2.5, w, h); } catch (e) {} }
            else { doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.text('Pesties', W - M, 11.5, { align: 'right' }); }
            doc.setTextColor(71, 85, 105); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
            doc.text(sub + (v.address ? ' · ' + v.address : ''), M, 24);
            y = 30;
        };
        const newPage = () => { doc.addPage(); header(); };
        const room = h => { if (y + h > H - 12) newPage(); };
        const heading = s => { room(14); doc.setTextColor(15, 23, 42); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(s, M, y); y += 6; };
        const para = s => { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(51, 65, 85); doc.splitTextToSize(String(s), W - 2 * M).forEach(line => { room(5); doc.text(line, M, y); y += 4.4; }); y += 2; };
        const facts = pairs => {
            const colW = (W - 2 * M) / pairs.length;
            room(16);
            pairs.forEach(([k, val], i) => {
                const x0 = M + i * colW;
                doc.setFillColor(241, 245, 249); doc.roundedRect(x0, y, colW - 3, 14, 2, 2, 'F');
                doc.setTextColor(100, 116, 139); doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.text(String(k).toUpperCase(), x0 + 3, y + 4.5);
                doc.setTextColor(15, 23, 42); doc.setFontSize(11); doc.text(String(val), x0 + 3, y + 11);
            });
            y += 19;
        };
        // links: for each row, { column number: web address } - those cells are blue and open the address when clicked
        const table = (cols, rows, links) => {
            const total = cols.reduce((a, c) => a + c[1], 0), scale = (W - 2 * M) / total, widths = cols.map(c => c[1] * scale);
            const head = () => {
                doc.setFillColor(226, 232, 240); doc.rect(M, y, W - 2 * M, 7, 'F');
                doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(51, 65, 85);
                let x0 = M; cols.forEach((c, i) => { doc.text(String(c[0]).toUpperCase(), x0 + 1.5, y + 4.7); x0 += widths[i]; });
                y += 7;
            };
            room(14); head();
            if (!rows.length) { doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(100, 116, 139); doc.text('Nothing recorded.', M + 1.5, y + 5); y += 9; return; }
            rows.forEach((r, ri) => {
                doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
                const cells = r.map((val, i) => doc.splitTextToSize(String(val == null ? '' : val), widths[i] - 3));
                const h = Math.max(...cells.map(c => c.length)) * 3.4 + 2.6;
                if (y + h > H - 12) { newPage(); head(); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); }
                if (ri % 2) { doc.setFillColor(248, 250, 252); doc.rect(M, y, W - 2 * M, h, 'F'); }
                let x0 = M; cells.forEach((c, i) => {
                    const url = links && links[ri] && links[ri][i];
                    if (url) doc.setTextColor(37, 99, 235); else doc.setTextColor(15, 23, 42);
                    doc.text(c, x0 + 1.5, y + 3.9);
                    if (url) { try { doc.link(x0, y, widths[i], h, { url }); } catch (e) {} }
                    x0 += widths[i];
                });
                y += h;
            });
            y += 5;
        };
        const alert = lines => {
            const wrapped = lines.map(l => doc.splitTextToSize(l, W - 2 * M - 8));
            const n = wrapped.reduce((a, l) => a + l.length, 0);
            room(10 + n * 5);
            doc.setFillColor(254, 226, 226); doc.setDrawColor(239, 68, 68); doc.roundedRect(M, y, W - 2 * M, 8 + n * 5, 2, 2, 'FD');
            doc.setTextColor(153, 27, 27); doc.setFontSize(9);
            let ly = y + 6;
            wrapped.forEach((l, i) => { doc.setFont('helvetica', i ? 'normal' : 'bold'); doc.text(l, M + 4, ly); ly += l.length * 5; });
            y += 12 + n * 5;
        };

        header();
        if ((v.breaches || []).length) alert(['CRITICAL LIMIT BREACH'].concat(v.breaches));
        facts([['Arrived', v.start ? time(v.start) : '-'], ['Left', v.inProgress ? 'In progress' : time(v.end || v.completed)],
            ['Time on site', v.inProgress ? '-' : dur(v.start, v.end || v.completed)], ['Stations checked', v.stationsChecked != null ? v.stationsChecked : new Set((v.entries || []).map(e => e.barcode)).size]]);
        if ((v.services || []).length) para('Services completed: ' + v.services.join(', '));
        heading("Technician's notes"); para(v.notes || 'No notes provided');
        heading('Station records');
        const stLink = b => portalLink(v.siteId, 'station', b);
        table(ENTRY_COLS, (v.entries || []).map(e => [e.name, e.barcode, e.type, e.activity === 'None' || !e.activity ? 'No activity' : e.activity, e.pests || '-', e.prep || '-', e.notes || '']),
            (v.entries || []).map(e => ({ 0: stLink(e.barcode), 1: stLink(e.barcode) })));
        if ((v.recs || []).length) {
            heading('Recommendations raised');
            table(REC_COLS, v.recs.map(r => [r.no || '', r.status || '', day(r.raised), r.station || '', r.barcode || '', r.text || '', r.closed ? day(r.closed) : '', r.note || '']),
                v.recs.map(r => ({ 0: portalLink(v.siteId, 'rec', r.id), 5: portalLink(v.siteId, 'rec', r.id), 3: r.barcode ? stLink(r.barcode) : null })));
        }
        if (v.siteId != null && v.id) {   // the whole visit, in the Client Portal
            room(8); doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(37, 99, 235);
            const txt = 'Open this visit report in the Pesties Client Portal';
            try { doc.textWithLink(txt, M, y, { url: portalLink(v.siteId, 'visit', v.id) }); } catch (e) { doc.text(txt, M, y); }
            y += 7;
        }
        if (v.signedBy || v.noSignatureReason) {
            heading('Customer sign-off');
            if (v.signedBy && v.signature) { room(30); try { doc.addImage(v.signature, v.signature.startsWith('data:image/png') ? 'PNG' : 'JPEG', M, y, 70, 24); y += 27; } catch (e) {} }
            para(v.signedBy ? `Signed by ${v.signedBy}${v.signedAt ? ' on ' + dayTime(v.signedAt) : ''}` : `Not signed: ${v.noSignatureReason}`);
        }
        const n = doc.getNumberOfPages();
        for (let i = 1; i <= n; i++) {
            doc.setPage(i); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(148, 163, 184);
            doc.text(`Generated ${dayTime(Date.now())}${v.by ? ' by ' + v.by : ''} · Pesties ${v.app || ''}`.trim(), M, H - 6);
            doc.text(`Page ${i} of ${n}`, W - M, H - 6, { align: 'right' });
        }
        const d = t(v.completed) ? new Date(t(v.completed)) : new Date();
        doc.save(`${safe(v.siteName)} - Visit report - ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.pdf`);
    }
    // ---------- Heat map: pest activity drawn over a floor plan (the same in all three apps) ----------
    // Each station's activity in the time frame chosen, for the pests ticked (none ticked = every pest and any activity):
    // a catch counts its number, a check with only activity counts Low 1, Medium 2, High 3. The busiest station is red.
    const HEAT_PERIODS = [['1m', 'Last month'], ['3m', 'Last 3 months'], ['6m', 'Last 6 months'], ['12m', 'Last 12 months'], ['ytd', 'This year'], ['ly', 'Last year'], ['all', 'All time']];
    const heatKey = p => String(p || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
    function heatSpan(period) {
        const now = new Date(), y = now.getFullYear(), m = now.getMonth(), end = Date.now() + 60000;
        const back = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 }[period];
        if (back) return [new Date(y, m - back, now.getDate()).getTime(), end];
        if (period === 'ytd') return [new Date(y, 0, 1).getTime(), end];
        if (period === 'ly') return [new Date(y - 1, 0, 1).getTime(), new Date(y, 0, 1).getTime()];
        return [0, end];
    }
    // st = { period, pests: [] }; stations = [{ x, y, name, recs: [{ at, species, count, activity }] }] -> [{ x, y, name, v }]
    function heatPoints(stations, st) {
        const [a, b] = heatSpan(st.period), want = (st.pests || []).map(heatKey);
        const lvl = { Low: 1, Medium: 2, High: 3, Caught: 1 };
        return stations.filter(x => x.x != null && x.y != null).map(x => {
            const v = (x.recs || []).filter(r => r.at >= a && r.at < b).reduce((n, r) => {
                const sp = r.species && r.species !== 'None' ? r.species : '';
                if (want.length) return n + (sp && want.includes(heatKey(sp)) ? (Number(r.count) > 0 ? Number(r.count) : 1) : 0);
                return n + (sp ? (Number(r.count) > 0 ? Number(r.count) : 1) : (lvl[r.activity] || 0));
            }, 0);
            return { x: x.x, y: x.y, name: x.name, v };
        });
    }
    // the colours, from a little (blue) to the most (red)
    const HEAT_STOPS = [[0, [37, 99, 235]], [.35, [22, 163, 74]], [.6, [234, 179, 8]], [.8, [234, 88, 12]], [1, [220, 38, 38]]];
    const heatRgb = t => { for (let i = 1; i < HEAT_STOPS.length; i++) if (t <= HEAT_STOPS[i][0]) { const [t0, c0] = HEAT_STOPS[i - 1], [t1, c1] = HEAT_STOPS[i], f = (t - t0) / (t1 - t0 || 1); return c0.map((c, k) => Math.round(c + (c1[k] - c) * f)); } return HEAT_STOPS[HEAT_STOPS.length - 1][1]; };
    // the heat as a picture the shape of the plan (w x h, drawn smaller and stretched over it); pts from heatPoints
    function heatCanvas(w, h, pts) {
        const k = Math.min(1, 900 / Math.max(w, h, 1)), W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const hot = pts.filter(p => p.v > 0), max = Math.max(1, ...hot.map(p => p.v));
        if (!hot.length) return c;
        const g = c.getContext('2d'), r = Math.max(W, H) * .11;
        hot.forEach(p => {
            const x = p.x * W, y = p.y * H, gr = g.createRadialGradient(x, y, 0, x, y, r);
            gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
            g.globalAlpha = .3 + .7 * Math.sqrt(p.v / max);   // any activity shows; the busiest the most
            g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
        });
        const img = g.getImageData(0, 0, W, H), d = img.data;
        for (let i = 0; i < d.length; i += 4) {
            const t = d[i + 3] / 255; if (!t) continue;
            const [cr, cg, cb] = heatRgb(Math.min(1, t));
            d[i] = cr; d[i + 1] = cg; d[i + 2] = cb; d[i + 3] = Math.round(Math.min(1, t * 1.6) * 175);
        }
        g.putImageData(img, 0, 0);
        return c;
    }
    // the controls: the time frame, and the pests to tick (type to search). cb is the name of the app's function, called
    // cb('period', value) and cb('pest', name, ticked) (cb('pests', []) to clear). pts gives the count of stations with activity.
    let heatCssDone = false;
    function heatCss() {
        if (heatCssDone || typeof document === 'undefined') return; heatCssDone = true;
        const s = document.createElement('style');
        s.textContent = `.heat-panel{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.6rem 1.5rem;font-size:12px;color:var(--text,#0f172a);text-align:left}
.heat-panel select,.heat-dd-pop input[type=search]{font:inherit;font-weight:600;color:var(--text,#0f172a);background:var(--surface,#fff);border:1px solid var(--border,#cbd5e1);border-radius:.5rem;padding:.35rem .5rem}
.heat-f{display:flex;flex-direction:column;gap:.25rem}.heat-f>span{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--faint,#64748b)}
.heat-dd{position:relative;min-width:11rem;max-width:18rem}
.heat-dd-btn{width:100%;text-align:left;font:inherit;font-weight:600;color:var(--text,#0f172a);background:var(--surface,#fff);border:1px solid var(--border,#cbd5e1);border-radius:.5rem;padding:.35rem 1.7rem .35rem .55rem;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:relative}
.heat-dd-btn::after{content:'';position:absolute;right:.6rem;top:50%;width:.4rem;height:.4rem;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-70%) rotate(45deg);opacity:.55}
.heat-dd-btn.on{border-color:#ea580c;box-shadow:0 0 0 1px #ea580c inset}
.heat-dd-pop{position:absolute;z-index:95;top:calc(100% + 4px);left:0;width:max(100%,15rem);max-width:90vw;background:var(--surface,#fff);border:1px solid var(--border,#cbd5e1);border-radius:.7rem;box-shadow:0 14px 34px rgba(0,0,0,.22);padding:.4rem}
.heat-dd-pop[hidden]{display:none}.heat-dd-pop input[type=search]{width:100%;margin-bottom:.3rem}
.heat-dd-bar{display:flex;gap:.3rem;margin-bottom:.3rem}.heat-dd-bar button{font:inherit;font-size:11px;font-weight:700;color:var(--muted,#475569);background:var(--surface2,#f1f5f9);border:1px solid var(--border,#cbd5e1);border-radius:.45rem;padding:.25rem .55rem;cursor:pointer}
.heat-dd-bar .heat-done{margin-left:auto;color:#fff;background:#ea580c;border-color:transparent}
.heat-list{max-height:14rem;overflow-y:auto}
.heat-list label{display:flex;align-items:center;gap:.45rem;padding:.3rem .4rem;border-radius:.35rem;cursor:pointer;font-weight:600}.heat-list label:hover{background:var(--surface2,#f1f5f9)}
.heat-list input{width:15px;height:15px;accent-color:#ea580c}
.heat-ctrls{display:flex;flex-wrap:wrap;align-items:flex-end;gap:.6rem .9rem}
.heat-key{display:flex;flex-direction:column;gap:.35rem;flex:0 1 26rem;min-width:14rem}.heat-scale{display:flex;align-items:center;gap:.5rem;font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--faint,#64748b);white-space:nowrap}.heat-scale .heat-bar{flex:1}.heat-bar{height:10px;border-radius:99px;background:linear-gradient(90deg,rgb(37,99,235),rgb(22,163,74),rgb(234,179,8),rgb(234,88,12),rgb(220,38,38))}
.heat-bar-l{display:flex;justify-content:space-between;font-size:10px;font-weight:700;color:var(--faint,#64748b)}.heat-sum{font-weight:700;color:var(--muted,#475569);text-align:right}
.heat-layer{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
@media (max-width:640px){.heat-panel{gap:.5rem .6rem}.heat-key{flex:1 1 100%;min-width:0}.heat-sum{text-align:left}.heat-dd{min-width:9rem}}
.pz-view{position:relative;overflow:hidden;touch-action:none;user-select:none;-webkit-user-select:none;background:var(--surface2,#f1f5f9);border-radius:.7rem;cursor:grab;height:min(70vh,560px);min-height:240px}
.pz-view.pz-drag{cursor:grabbing}.pz-stage{position:absolute;left:0;top:0;transform-origin:0 0}
.pz-stage>canvas.pz-page{display:block;width:100%;height:100%;pointer-events:none}.pz-box{position:absolute}.pz-stage>img{display:block;max-width:none;width:100%;height:100%;pointer-events:none;-webkit-user-drag:none}
.pz-ctl{position:absolute;right:.5rem;top:.5rem;z-index:20;display:flex;flex-direction:column;gap:.3rem}
.pz-ctl button{width:2.25rem;height:2.25rem;border-radius:.6rem;border:1px solid var(--border,#cbd5e1);background:var(--surface,#fff);color:var(--text,#0f172a);font-weight:900;font-size:1rem;line-height:1;cursor:pointer;box-shadow:0 4px 12px -4px rgba(0,0,0,.35)}
.pz-ctl button.pz-fit{font-size:9px}
.pz-view.pz-full{position:fixed;inset:0;z-index:2000;height:auto;min-height:0;border-radius:0;background:var(--bg,#fff)}
body.pz-lock{overflow:hidden}`;
        document.head.appendChild(s);
        // tapping anywhere else closes an open pest list
        document.addEventListener('pointerdown', ev => { document.querySelectorAll('.heat-dd-pop:not([hidden])').forEach(p => { if (!p.parentElement.contains(ev.target)) p.hidden = true; }); });
    }
    function heatPanel(cb, st, pests, pts) {
        heatCss();
        const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const on = new Set((st.pests || []).map(heatKey)), hot = (pts || []).filter(p => p.v > 0), top = hot.slice().sort((p, q) => q.v - p.v)[0];
        const ticked = pests.filter(p => on.has(heatKey(p))), txt = !on.size ? 'All pests' : ticked.length === 1 ? ticked[0] : `${on.size} pests`;
        return `<div class="heat-panel" data-heat-cb="${esc(cb)}"><div class="heat-ctrls">
            <label class="heat-f"><span>Time frame</span><select onchange="${esc(cb)}('period', this.value)">${HEAT_PERIODS.map(([v, l]) => `<option value="${v}" ${st.period === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <div class="heat-f"><span>Pests</span><div class="heat-dd">
                <button type="button" class="heat-dd-btn ${on.size ? 'on' : ''}" onclick="PVR.heatOpen(this)" aria-haspopup="listbox" title="${esc(ticked.join(', ') || txt)}">${esc(txt)}</button>
                <div class="heat-dd-pop" hidden><input type="search" placeholder="Search pests..." aria-label="Search pests" oninput="PVR.heatFilter(this)">
                    <div class="heat-dd-bar"><button type="button" onclick="${esc(cb)}('pests', [])">Clear (all pests)</button><button type="button" class="heat-done" onclick="PVR.heatOpen(this, false)">Done</button></div>
                    <div class="heat-list" role="listbox" aria-multiselectable="true">${pests.map(p => `<label data-q="${esc(String(p).toLowerCase())}"><input type="checkbox" value="${esc(p)}" ${on.has(heatKey(p)) ? 'checked' : ''} onchange="${esc(cb)}('pest', this.value, this.checked)">${esc(p)}</label>`).join('') || '<div class="heat-bar-l" style="padding:.4rem">No pests recorded yet</div>'}</div></div></div></div>
            </div><div class="heat-key"><div class="heat-scale"><span>A little</span><div class="heat-bar"></div><span>The most</span></div>
                <div class="heat-sum">${hot.length ? `${hot.length} station${hot.length === 1 ? '' : 's'} with activity${top ? ` · most at ${esc(top.name)} (${Math.round(top.v * 10) / 10})` : ''}` : 'No activity for this choice'}</div></div>
        </div>`;
    }
    // the pest drop-down: open (or close) it; it stays open while pests are ticked
    function heatOpen(el, open) {
        const pop = el.closest('.heat-dd').querySelector('.heat-dd-pop');
        pop.hidden = open === false ? true : open === true ? false : !pop.hidden;
        // kept on the screen (a phone's right-hand edge)
        if (!pop.hidden) { pop.style.left = '0px'; const r = pop.getBoundingClientRect(), over = r.right - (window.innerWidth - 8); if (over > 0) pop.style.left = -Math.min(over, r.left - 8) + 'px'; }
        if (!pop.hidden) { const q = pop.querySelector('input[type=search]'); if (q && window.matchMedia && window.matchMedia('(pointer: fine)').matches) q.focus(); }
    }
    function heatFilter(input) {
        const q = input.value.trim().toLowerCase(), box = input.closest('.heat-dd-pop');
        if (box) box.querySelectorAll('.heat-list label').forEach(l => { l.style.display = !q || l.dataset.q.includes(q) ? '' : 'none'; });
    }
    // puts the controls in box again, keeping the pest list open, what was typed in its search and where it was scrolled to
    function heatMount(box, html) {
        if (!box) return;
        const pop = box.querySelector('.heat-dd-pop'), open = pop && !pop.hidden, old = box.querySelector('.heat-dd-pop input[type=search]'), q = old ? old.value : '', l = box.querySelector('.heat-list'), top = l ? l.scrollTop : 0;
        box.innerHTML = html;
        const p2 = box.querySelector('.heat-dd-pop'); if (p2 && open) { p2.hidden = false; p2.style.left = pop.style.left; }
        const n = box.querySelector('.heat-dd-pop input[type=search]'); if (n && q) { n.value = q; heatFilter(n); }
        const l2 = box.querySelector('.heat-list'); if (l2) l2.scrollTop = top;
    }
    // the pests ticked, after cb('pest', name, on) / cb('pests', [])
    function heatTick(st, k, v, on) {
        if (k === 'period') st.period = v;
        if (k === 'pests') st.pests = [];
        if (k === 'pest') { st.pests = (st.pests || []).filter(p => heatKey(p) !== heatKey(v)); if (on) st.pests.push(v); }
        return st;
    }

    // ---------- A floor plan you can move around: drag it, zoom in and out (buttons, the mouse wheel, two fingers), Fit, and Full screen ----------
    // view (.pz-view) holds stage (.pz-stage: the plan picture, the heat map and the pins, placed in shares of the plan); w x h is the
    // plan's size. Pins stay the same size on screen at every zoom (CSS var --pz-inv). A tap on a pin still works; a drag doesn't tap.
    function panZoom(view, stage, w, h) {
        heatCss();
        if (view._pz) view._pz.stop();
        const v = { z: 1, x: 0, y: 0, fit: 1, atFit: true };
        stage.style.width = w + 'px'; stage.style.height = h + 'px';
        let ctl = view.querySelector(':scope > .pz-ctl');
        if (!ctl) {
            ctl = document.createElement('div'); ctl.className = 'pz-ctl';
            ctl.innerHTML = '<button type="button" data-pz="in" title="Zoom in" aria-label="Zoom in">+</button><button type="button" data-pz="out" title="Zoom out" aria-label="Zoom out">−</button><button type="button" data-pz="fit" class="pz-fit" title="Show the whole plan" aria-label="Show the whole plan">FIT</button><button type="button" data-pz="full" title="Full screen" aria-label="Full screen">⛶</button>';
            view.appendChild(ctl);
        }
        const apply = () => { stage.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`; stage.style.setProperty('--pz-inv', String(1 / v.z)); };
        const size = () => {
            if (view.classList.contains('pz-full')) { view.style.height = ''; return; }
            const want = Math.round(Math.min(Math.max(240, view.clientWidth * h / w), window.innerHeight * .85));
            if (Math.abs(view.clientHeight - want) > 2) view.style.height = want + 'px';
        };
        const fit = () => {
            size();
            const vw = view.clientWidth, vh = view.clientHeight; if (!vw || !vh) return;
            v.fit = Math.min(vw / w, vh / h) * .98; v.z = v.fit; v.x = (vw - w * v.z) / 2; v.y = (vh - h * v.z) / 2; v.atFit = true; apply();
        };
        const zoomAt = (f, cx, cy) => {
            if (cx == null) { cx = view.clientWidth / 2; cy = view.clientHeight / 2; }
            const nz = Math.min(Math.max(v.z * f, v.fit * .6), v.fit * 14);
            v.x = cx - (cx - v.x) * (nz / v.z); v.y = cy - (cy - v.y) * (nz / v.z); v.z = nz; v.atFit = false; apply();
        };
        // a spot on the plan (shares) in the middle, zoomed in
        const focus = (fx, fy) => { fit(); const z = v.fit * 3; v.z = z; v.x = view.clientWidth / 2 - fx * w * z; v.y = view.clientHeight / 2 - fy * h * z; v.atFit = false; apply(); };
        // full screen: the plan is lifted out to the page itself (a card's styling can't trap it), and put back after
        let spot = null;
        const full = on => { if (on && !spot) { spot = document.createComment('pz'); view.before(spot); document.body.appendChild(view); } if (!on && spot) { spot.replaceWith(view); spot = null; } view.classList.toggle('pz-full', on); document.body.classList.toggle('pz-lock', on); const b = ctl.querySelector('[data-pz=full]'); b.textContent = on ? '✕' : '⛶'; b.title = on ? 'Close full screen' : 'Full screen'; requestAnimationFrame(fit); };
        const onCtl = ev => { const b = ev.target.closest('[data-pz]'); if (!b) return; ev.stopPropagation();
            const k = b.dataset.pz; if (k === 'in') zoomAt(1.4); if (k === 'out') zoomAt(1 / 1.4); if (k === 'fit') fit(); if (k === 'full') full(!view.classList.contains('pz-full')); };
        // dragging and pinching
        const pts = new Map(); let moved = 0, pinch = null, last = null;
        const local = e => { const r = view.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
        const down = e => { if (e.target.closest('.pz-ctl')) return; pts.set(e.pointerId, local(e)); moved = 0; last = local(e); if (pts.size === 2) { const [a, b] = Array.from(pts.values()); pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) }; } };
        const move = e => {
            if (!pts.has(e.pointerId)) return;
            const p = local(e); pts.set(e.pointerId, p);
            if (pts.size === 2 && pinch) { const [a, b] = Array.from(pts.values()), d = Math.hypot(a.x - b.x, a.y - b.y); if (pinch.d) zoomAt(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2); pinch.d = d; moved += 10; return; }
            const dx = p.x - last.x, dy = p.y - last.y; last = p; moved += Math.abs(dx) + Math.abs(dy);
            if (moved > 6) { if (!view.classList.contains('pz-drag')) { view.classList.add('pz-drag'); try { view.setPointerCapture(e.pointerId); } catch (x) {} } v.x += dx; v.y += dy; v.atFit = false; apply(); }
        };
        const up = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; if (pts.size === 1) last = Array.from(pts.values())[0]; if (!pts.size) view.classList.remove('pz-drag'); };
        // a drag isn't a tap; a tap on a pin in full screen leaves full screen first (so what it opens shows on top)
        const click = e => { if (e.target.closest('.pz-ctl')) return; if (moved > 6) { e.stopPropagation(); e.preventDefault(); } else if (view.classList.contains('pz-full') && e.target.closest('button, a, [onclick]') && e.target.closest('.pz-stage')) full(false); moved = 0; };
        const wheel = e => { e.preventDefault(); const p = local(e); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y); };
        const key = e => { if (e.key === 'Escape' && view.classList.contains('pz-full')) full(false); };
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (v.atFit) fit(); else size(); }) : null;
        ctl.addEventListener('click', onCtl);
        view.addEventListener('pointerdown', down); view.addEventListener('pointermove', move); view.addEventListener('pointerup', up); view.addEventListener('pointercancel', up);
        view.addEventListener('click', click, true); view.addEventListener('wheel', wheel, { passive: false }); document.addEventListener('keydown', key);
        if (ro) ro.observe(view);
        const stop = () => { ctl.removeEventListener('click', onCtl); view.removeEventListener('pointerdown', down); view.removeEventListener('pointermove', move); view.removeEventListener('pointerup', up); view.removeEventListener('pointercancel', up);
            view.removeEventListener('click', click, true); view.removeEventListener('wheel', wheel); document.removeEventListener('keydown', key); if (ro) ro.disconnect(); document.body.classList.remove('pz-lock'); if (spot) { spot.replaceWith(view); spot = null; view.classList.remove('pz-full'); } };
        fit();
        view._pz = { fit, zoomAt, focus, full, stop, view: v };
        return view._pz;
    }

    return { build, logo, pestMap, pestMapPage, pin, portalLink, heatPoints, heatCanvas, heatPanel, heatOpen, heatFilter, heatTick, heatMount, panZoom };
})();

// ---------- Boards: boxes you can drag into a new order and resize (width and height), like the Service App's site page ----------
// BOARD.attach(el, key, defaults): el's children with data-box="<id>" become boxes; defaults = { <id>: <width as a share of the row, e.g. .6667> }.
// On a computer the boxes sit in a grid of 12 columns and fill any space above them (a short box doesn't leave a gap under
// it - the boxes after it move up into the space). Each person's layout is kept in this browser under key.
// On a phone the boxes are one under the other, full width and as tall as they need.
const BOARD = (() => {
    const GAP = 20, ROW = 4, MINH = 160;
    const wide = () => window.innerWidth >= 1024;
    function css() {
        if (document.getElementById('bdCss')) return;
        const st = document.createElement('style'); st.id = 'bdCss';
        const inner = '>:not(.bd-resize):not(.bd-move)';
        st.textContent = '.bd-board{display:flex;flex-direction:column;gap:' + GAP + 'px}.bd-board>.bd-box{position:relative;min-width:0}'
            + '@media (min-width:1024px){.bd-board{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-rows:' + ROW + 'px;grid-auto-flow:row dense;column-gap:' + GAP + 'px;row-gap:0;align-items:start}'
            + '.bd-board>.bd-box{grid-column:span var(--bd-c,6);grid-row:span var(--bd-r,40);padding-bottom:' + GAP + 'px}'
            + '.bd-board>.bd-box.bd-hset' + inner + '{height:var(--bd-h);overflow:auto}.bd-board>.bd-box.bd-hset' + inner + '>.card{min-height:100%}'
            + '.bd-board>.bd-box>.bd-resize{bottom:' + (GAP + 5) + 'px}}'
            + '.bd-resize{position:absolute;right:5px;bottom:5px;width:16px;height:16px;cursor:nwse-resize;touch-action:none;opacity:.45;z-index:3;border-radius:0 0 .6rem 0;background:linear-gradient(135deg,transparent 0 55%,currentColor 55% 62%,transparent 62% 72%,currentColor 72% 79%,transparent 79%)}'
            + '.bd-resize:hover{opacity:1}.bd-move{cursor:grab;touch-action:none;user-select:none;opacity:.5;font-size:15px;line-height:1;padding:2px 4px;border-radius:6px;position:absolute;top:8px;left:50%;transform:translateX(-50%);z-index:3}.bd-move:hover{opacity:1;background:rgba(127,127,127,.15)}'
            + '.bd-box.bd-drag' + inner + '{outline:2px dashed rgb(var(--b500,249 115 22));outline-offset:3px;opacity:.85}.bd-box.bd-sizing' + inner + '{outline:2px solid rgb(var(--b500,249 115 22) / .6);outline-offset:3px}'
            + '@media (max-width:1023px){.bd-resize,.bd-move{display:none}}';
        document.head.appendChild(st);
    }
    const load = key => { try { return JSON.parse(localStorage.getItem(key) || 'null') || {}; } catch (e) { return {}; } };
    const save = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) {} };
    const cols = f => Math.min(12, Math.max(3, Math.round(f * 12)));   // a quarter of the width up to all of it
    const innerOf = b => Array.from(b.children).find(c => !c.classList.contains('bd-resize') && !c.classList.contains('bd-move'));
    function attach(el, key, defaults) {
        if (!el) return;
        css();
        el.classList.add('bd-board');
        const boxes = () => Array.from(el.children).filter(c => c.dataset && c.dataset.box);
        const lay = load(key);
        // the saved order (new boxes go where they are), then each box's size
        const order = (lay.order || []).filter(id => boxes().some(b => b.dataset.box === id));
        boxes().forEach(b => { if (!order.includes(b.dataset.box)) order.splice(Math.min(order.length, boxes().indexOf(b)), 0, b.dataset.box); });
        order.forEach(id => { const b = boxes().find(x => x.dataset.box === id); if (b) el.appendChild(b); });
        boxes().forEach(b => {
            b.classList.add('bd-box');
            const s = (lay.boxes || {})[b.dataset.box] || {};
            b.dataset.f = String(s.f || (defaults && defaults[b.dataset.box]) || .5);
            b.style.setProperty('--bd-c', String(cols(Number(b.dataset.f))));
            if (s.h) { b.style.setProperty('--bd-h', s.h + 'px'); b.classList.add('bd-hset'); }
            if (!b.querySelector(':scope > .bd-resize')) b.insertAdjacentHTML('beforeend', '<span class="bd-resize" title="Drag to resize · double-click for its own height" aria-hidden="true"></span><span class="bd-move" title="Drag to move this box" aria-hidden="true">⠿</span>');
        });
        // each box takes as many grid rows as it is tall
        let queued = false;
        const layout = () => {
            queued = false;
            if (!el.isConnected) return;
            boxes().forEach(b => {
                if (!wide()) { b.style.removeProperty('--bd-r'); return; }
                const inner = innerOf(b), h = inner ? inner.getBoundingClientRect().height : 0;
                b.style.setProperty('--bd-r', String(Math.max(1, Math.ceil((h + GAP) / ROW))));
            });
        };
        const relayout = () => { if (!queued) { queued = true; requestAnimationFrame(layout); } };
        layout();
        if (window.ResizeObserver) { const ro = new ResizeObserver(relayout); boxes().forEach(b => { const i = innerOf(b); if (i) ro.observe(i); }); }
        window.addEventListener('resize', relayout);
        const store = () => {
            const v = { order: boxes().map(b => b.dataset.box), boxes: {} };
            boxes().forEach(b => { v.boxes[b.dataset.box] = { f: Number(b.dataset.f) || .5, h: b.classList.contains('bd-hset') ? parseInt(b.style.getPropertyValue('--bd-h'), 10) || null : null }; });
            save(key, v);
        };
        if (el._bdBound) return;
        el._bdBound = true;
        el.addEventListener('pointerdown', e => {
            const handle = e.target.closest('.bd-resize, .bd-move');
            if (!handle || !el.contains(handle)) return;
            const box = handle.closest('.bd-box');
            e.preventDefault();
            const W = el.getBoundingClientRect().width, inner = innerOf(box), r0 = (inner || box).getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
            const sizing = handle.classList.contains('bd-resize');
            box.classList.add(sizing ? 'bd-sizing' : 'bd-drag');
            const move = ev => {
                if (sizing) {
                    const c = cols((r0.width + ev.clientX - x0 + GAP) / (W + GAP));
                    box.dataset.f = String(c / 12); box.style.setProperty('--bd-c', String(c));
                    box.style.setProperty('--bd-h', Math.max(MINH, Math.round(r0.height + ev.clientY - y0)) + 'px'); box.classList.add('bd-hset');
                    relayout();
                } else {
                    const over = document.elementFromPoint(ev.clientX, ev.clientY), target = over && over.closest('.bd-box');
                    if (!target || target === box || target.parentElement !== el) return;
                    const r = target.getBoundingClientRect(), after = ev.clientX > r.left + r.width / 2 || ev.clientY > r.bottom - 10;
                    el.insertBefore(box, after ? target.nextSibling : target);
                    relayout();
                }
            };
            const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); box.classList.remove('bd-sizing', 'bd-drag'); store(); relayout(); window.dispatchEvent(new Event('resize')); };
            window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
        });
        // double-click the corner: back to its own height
        el.addEventListener('dblclick', e => { const h = e.target.closest('.bd-resize'); if (!h) return; const b = h.closest('.bd-box'); b.classList.remove('bd-hset'); b.style.removeProperty('--bd-h'); store(); relayout(); });
    }
    function reset(key) { try { localStorage.removeItem(key); } catch (e) {} }
    return { attach, reset };
})();

// ---------- Thumbnails kept on this device: photos and videos shown small load straight away the next time ----------
// Any picture or video from the server (/api/files/...) shown as a thumbnail (in a card, a gallery strip, a station box)
// is made into a small JPEG the first time it loads and saved in this browser; after that the saved one is shown at once,
// and a video thumbnail shows its saved first frame instead of loading the video. Full-size viewers are left alone.
const THUMBS = (() => {
    const SMALL = '[class*="thumb"], .rec-media, .rec-card, .nf-card, .station-photo-box, .map-pop-photo, .plan-card';
    const FULL = '#viewer, #imageModal, .rec-hero, .pest-hero, #zoomStage';
    const MAX = 360, KEEP = 3000;
    let dbP = null;
    const db = () => dbP || (dbP = new Promise((res, rej) => {
        const r = indexedDB.open('pestis-thumbs', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('t');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }).catch(() => null));
    const tx = async (mode, fn) => { const d = await db(); if (!d) return null; return await new Promise(res => { try { const s = d.transaction('t', mode).objectStore('t'); const q = fn(s); q.onsuccess = () => res(q.result); q.onerror = () => res(null); } catch (e) { res(null); } }); };
    const get = key => tx('readonly', s => s.get(key));
    const put = (key, val) => tx('readwrite', s => s.put(val, key));
    // the file a link points at, without the signature that changes each time
    const keyOf = src => { const m = /\/api\/files\/([^?#]+)/.exec(String(src || '')); return m ? decodeURIComponent(m[1]) : null; };
    const urls = new Map();   // key -> object URL made this session
    async function saved(key) {
        if (urls.has(key)) return urls.get(key);
        const v = await get(key);
        if (!v || !v.blob) return null;
        const u = URL.createObjectURL(v.blob); urls.set(key, u);
        return u;
    }
    function shrink(el, w, h) {
        const k = Math.min(1, MAX / Math.max(w, h)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
        return new Promise(res => { try { c.toBlob(b => res(b), 'image/jpeg', .78); } catch (e) { res(null); } });
    }
    async function store(key, blob) {
        if (!blob) return;
        await put(key, { blob, at: Date.now() });
        if (Math.random() < .05) prune();
    }
    async function prune() {   // keep the newest few thousand
        const d = await db(); if (!d) return;
        const all = []; await new Promise(res => { const c = d.transaction('t').objectStore('t').openCursor(); c.onsuccess = () => { const cur = c.result; if (!cur) return res(); all.push([cur.key, cur.value.at || 0]); cur.continue(); }; c.onerror = res; });
        if (all.length <= KEEP) return;
        all.sort((a, b) => a[1] - b[1]);
        const s = d.transaction('t', 'readwrite').objectStore('t');
        all.slice(0, all.length - KEEP).forEach(([k]) => s.delete(k));
    }
    async function handle(el) {
        if (el.dataset.thumbDone) return;
        const src = el.currentSrc || el.getAttribute('src') || '', key = keyOf(src);
        if (!key || !el.closest(SMALL) || el.closest(FULL)) return;
        el.dataset.thumbDone = '1';
        const have = await saved(key);
        if (el.tagName === 'IMG') {
            if (have) { el.src = have; return; }
            const done = async () => { if (el.naturalWidth) store(key, await shrink(el, el.naturalWidth, el.naturalHeight)); };
            if (el.complete && el.naturalWidth) done(); else el.addEventListener('load', done, { once: true });
        } else if (el.tagName === 'VIDEO') {
            if (have) { el.poster = have; el.preload = 'none'; return; }
            const grab = async () => { if (el.videoWidth) store(key, await shrink(el, el.videoWidth, el.videoHeight)); };
            if (el.readyState >= 2) grab(); else el.addEventListener('loadeddata', grab, { once: true });
        }
    }
    function scan(root) { (root.querySelectorAll ? root.querySelectorAll('img, video') : []).forEach(handle); if (root.tagName === 'IMG' || root.tagName === 'VIDEO') handle(root); }
    function start() {
        if (!window.indexedDB || !window.MutationObserver || !document.body) return;
        new MutationObserver(list => list.forEach(m => {
            if (m.type === 'attributes') { m.target.dataset.thumbDone = ''; handle(m.target); }
            else m.addedNodes.forEach(n => { if (n.nodeType === 1) scan(n); });
        })).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        scan(document.body);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    return { keyOf, saved };
})();
/* PESTIS-VISITPDF:END */
