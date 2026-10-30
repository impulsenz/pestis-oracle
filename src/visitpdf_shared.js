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
    async function pestMap(d) {
        const { jsPDF } = window.jspdf;
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
        // the legend: every station type (how many are on this plan, or a dash), and overdue
        const count = new Map(); pins.forEach(x => count.set(x.type, (count.get(x.type) || 0) + 1));
        const all = (d.types || []).slice();
        pins.forEach(x => { if (!all.some(t => t.type === x.type)) all.push({ type: x.type, color: x.color }); });
        const overdue = pins.filter(x => x.overdue).length;
        const legItems = all.map(t => ({ t: t.type, n: count.get(t.type) || 0, color: t.color })).concat([{ t: 'Overdue for service', n: overdue, ring: true }]);
        const details = [['Client', d.siteName || '-'], ['Site address', d.address || '-'], ['Floor plan', d.planName || '-'], ['Stations on this plan', String(pins.length)],
            ['Map made by', d.madeBy || 'Pesties'], ['Last updated', day(d.updated || d.created) || '-'], ['Generated', `${day(Date.now())}${d.by ? ' by ' + d.by : ''}`]];
        const legCols = land ? 3 : 2, rowH = 56, legRows = Math.ceil(legItems.length / legCols);
        const dCols = land ? 2 : 2, dRowH = 76, dRows = Math.ceil(details.length / dCols);
        const legH = 100 + Math.max(legRows * rowH, dRows * dRowH) + 20;
        // header: navy, an orange line under it, the Pesties logo on the right
        const headH = 200;
        const grd = g.createLinearGradient(0, 0, W, headH); grd.addColorStop(0, '#0b1530'); grd.addColorStop(1, '#16244a');
        g.fillStyle = grd; g.fillRect(0, 0, W, headH);
        g.fillStyle = '#f97316'; g.fillRect(0, headH - 12, W, 12);
        const lg = await logo();
        let logoW = 0;
        if (lg) { const lh = 140, lw = lh * lg.k; logoW = lw + 50; g.drawImage(lg.img, W - M - lw, (headH - 12 - lh) / 2, lw, lh); }
        g.textBaseline = 'alphabetic';
        g.fillStyle = '#f97316'; g.font = font(800, 30); g.fillText('PEST MAP', M, 58);
        g.fillStyle = '#ffffff'; g.font = font(900, 64); g.fillText(fit(d.siteName || 'Site', W - M * 2 - logoW), M, 128);
        g.fillStyle = '#9db0d1'; g.font = font(600, 32); g.fillText(fit(`${d.planName || 'Floor plan'}${d.address ? '  ·  ' + d.address : ''}`, W - M * 2 - logoW), M, 172);
        // the plan: as big as the space between the header and the legend allows (keeping its shape), centred
        const top = headH + gap, bottom = H - M - legH - gap, boxW = W - M * 2, boxH = bottom - top;
        const k = Math.min(boxW / iw, boxH / ih), mw = iw * k, mh = ih * k, mx = M + (boxW - mw) / 2, my = top + (boxH - mh) / 2;
        g.drawImage(tr.img, mx, my, mw, mh);
        const r = Math.max(15, Math.min(36, Math.min(mw, mh) / 50));
        pins.forEach(x => pin(g, mx + x.x * mw, my + x.y * mh, r, x.color, x.overdue));
        if (d.labels) {
            g.font = font(700, Math.round(r * 1.15)); g.textBaseline = 'middle';
            pins.forEach(x => {
                const px = mx + x.x * mw + r * 1.3, py = my + x.y * mh - r * Math.SQRT2, tw = g.measureText(x.name).width;
                g.fillStyle = 'rgba(2,6,23,.82)'; rr(px, py - r * .85, tw + r * 1.1, r * 1.7, r * .4); g.fill();
                g.fillStyle = '#fff'; g.fillText(x.name, px + r * .55, py);
            });
            g.textBaseline = 'alphabetic';
        }
        // the legend and map details card along the bottom
        const ly = H - M - legH, splitX = M + boxW * (land ? .6 : .55);
        g.fillStyle = '#f8fafc'; rr(M, ly, boxW, legH, 22); g.fill(); g.strokeStyle = '#e2e8f0'; g.lineWidth = 3; rr(M, ly, boxW, legH, 22); g.stroke();
        g.fillStyle = '#f97316'; g.font = font(800, 28); g.fillText('LEGEND', M + 44, ly + 62); g.fillText('MAP DETAILS', splitX + 44, ly + 62);
        g.fillStyle = '#64748b'; g.font = font(700, 24); g.textAlign = 'right'; g.fillText('Floor plan not to scale', splitX - 40, ly + 62); g.textAlign = 'left';
        g.strokeStyle = '#e2e8f0'; g.lineWidth = 3; g.beginPath(); g.moveTo(splitX, ly + 30); g.lineTo(splitX, ly + legH - 30); g.stroke();
        const lcW = (splitX - M - 70) / legCols;
        legItems.forEach((it, i) => {
            const x = M + 44 + (i % legCols) * lcW, y = ly + 122 + Math.floor(i / legCols) * rowH;
            if (it.ring) { g.beginPath(); g.arc(x + 16, y - 10, 15, 0, Math.PI * 2); g.strokeStyle = '#dc2626'; g.lineWidth = 5; g.stroke(); }
            else pin(g, x + 16, y + 8, 14, it.color, false);
            g.fillStyle = it.n ? '#0b1530' : '#94a3b8'; g.font = font(700, 25); g.fillText(fit(it.t, lcW - 110), x + 46, y);
            g.fillStyle = '#64748b'; g.font = font(800, 25); g.textAlign = 'right'; g.fillText(it.n ? String(it.n) : '-', x + lcW - 24, y); g.textAlign = 'left';
        });
        const dW = (M + boxW - splitX - 80) / dCols;
        details.forEach(([key, val], i) => {
            const x = splitX + 44 + (i % dCols) * dW, y = ly + 116 + Math.floor(i / dCols) * dRowH;
            g.fillStyle = '#64748b'; g.font = font(800, 19); g.fillText(key.toUpperCase(), x, y);
            g.fillStyle = '#0b1530'; g.font = font(700, 27); g.fillText(fit(val, dW - 20), x, y + 34);
        });
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
    return { build, logo, pestMap, pin, portalLink };
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
