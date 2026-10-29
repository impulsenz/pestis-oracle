/* PESTIS-VISITPDF:BEGIN - the visit report PDF and the A4 pest map (identical in the Service App and the Client Portal; edit visitpdf_shared.js and run sync_visitpdf.py) */
// Each app turns its own visit into the plain description below, so the report is the same wherever it's downloaded:
//   { siteName, address, completed, type, tech, start, end, inProgress, stationsChecked, services: [..], notes,
//     breaches: ['line', ..], entries: [{ name, barcode, type, activity, pests, prep, notes }],
//     recs: [{ no, status, raised, station, barcode, text, closed, note }],
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
    //       siteName, address, planName, madeBy, created, updated, by, app }
    async function pestMap(d) {
        const { jsPDF } = window.jspdf;
        const iw = d.image.naturalWidth || d.image.width, ih = d.image.naturalHeight || d.image.height;
        const land = iw >= ih;
        const W = land ? 3508 : 2480, H = land ? 2480 : 3508;   // A4 at 300 dpi
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d');
        const pad = 90, headH = 260, footH = 60;
        const types = Array.from(d.pins.reduce((m, x) => m.set(x.type, { n: ((m.get(x.type) || {}).n || 0) + 1, color: x.color }), new Map()).entries())
            .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));
        const overdue = d.pins.filter(x => x.overdue).length;
        const legItems = types.map(([t, o]) => ({ t, n: o.n, color: o.color })).concat(overdue ? [{ t: 'Overdue for service', n: overdue, ring: true }] : []);
        const details = [['Client', d.siteName || '-'], ['Site address', d.address || '-'], ['Floor plan', d.planName || '-'], ['Stations on this plan', String(d.pins.length)],
            ['Map made by', d.madeBy || 'Pesties'], ['Last updated', day(d.updated || d.created) || '-'], ['Generated', `${day(Date.now())}${d.by ? ' by ' + d.by : ''}`]];
        const legCols = land ? 2 : 1, legRows = Math.max(1, Math.ceil(legItems.length / legCols));   // room for the long station type names
        const legH = Math.max(130 + legRows * 70, 130 + Math.ceil(details.length / (land ? 4 : 2)) * 92);
        const font = (w, px) => `${w} ${px}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif`;
        const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
        const fit = (t, max) => { t = String(t); if (g.measureText(t).width <= max) return t; while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1); return t + '…'; };
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
        // header: the site, the plan, and the Pesties logo in the top right
        g.fillStyle = '#0b1530'; g.fillRect(0, 0, W, headH);
        g.fillStyle = '#f97316'; g.fillRect(0, headH - 14, W, 14);
        const lg = await logo();
        let logoW = 0;
        if (lg) { const lh = headH * .62, lw = lh * lg.k; logoW = lw + 60; g.drawImage(lg.img, W - pad - lw, (headH - 14 - lh) / 2, lw, lh); }
        g.textBaseline = 'alphabetic';
        g.fillStyle = '#f97316'; g.font = font(800, 38); g.fillText('PEST MAP', pad, 84);
        g.fillStyle = '#ffffff'; g.font = font(900, 76); g.fillText(fit(d.siteName || 'Site', W - pad * 2 - logoW), pad, 168);
        g.fillStyle = '#9db0d1'; g.font = font(600, 36); g.fillText(fit(`${d.planName || 'Floor plan'}${d.address ? '  ·  ' + d.address : ''}`, W - pad * 2 - logoW), pad, 222);
        // the plan, as big as the page allows
        const top = headH + pad * .6, boxH = H - top - legH - pad * 1.2 - footH, boxW = W - pad * 2;
        const k = Math.min(boxW / iw, boxH / ih), mw = iw * k, mh = ih * k, mx = pad + (boxW - mw) / 2, my = top + (boxH - mh) / 2;
        g.save(); g.shadowColor = 'rgba(15,23,42,.18)'; g.shadowBlur = 30; g.fillStyle = '#fff'; g.fillRect(mx, my, mw, mh); g.restore();
        g.drawImage(d.image, mx, my, mw, mh);
        g.strokeStyle = '#d8deeb'; g.lineWidth = 3; g.strokeRect(mx, my, mw, mh);
        const r = Math.max(14, Math.min(34, Math.min(mw, mh) / 55));
        const labelFont = font(700, Math.round(r * 1.15));
        d.pins.forEach(x => pin(g, mx + x.x * mw, my + x.y * mh, r, x.color, x.overdue));
        if (d.labels) {
            g.font = labelFont; g.textBaseline = 'middle';
            d.pins.forEach(x => {
                const px = mx + x.x * mw + r * 1.3, py = my + x.y * mh - r * Math.SQRT2, tw = g.measureText(x.name).width;
                g.fillStyle = 'rgba(2,6,23,.82)'; rr(px, py - r * .85, tw + r * 1.1, r * 1.7, r * .4); g.fill();
                g.fillStyle = '#fff'; g.fillText(x.name, px + r * .55, py);
            });
            g.textBaseline = 'alphabetic';
        }
        // legend and map details
        const ly = H - legH - footH - pad * .6, splitX = pad + boxW * (land ? .42 : .5);
        g.fillStyle = '#f8fafc'; rr(pad, ly, boxW, legH, 24); g.fill(); g.strokeStyle = '#e2e8f0'; g.lineWidth = 3; rr(pad, ly, boxW, legH, 24); g.stroke();
        g.fillStyle = '#f97316'; g.font = font(800, 30); g.fillText('LEGEND', pad + 50, ly + 68); g.fillText('MAP DETAILS', splitX + 50, ly + 68);
        g.strokeStyle = '#e2e8f0'; g.beginPath(); g.moveTo(splitX, ly + 36); g.lineTo(splitX, ly + legH - 36); g.stroke();
        const lcW = (splitX - pad - 80) / legCols;
        legItems.forEach((it, i) => {
            const x = pad + 50 + (i % legCols) * lcW, y = ly + 136 + Math.floor(i / legCols) * 70;
            if (it.ring) { g.beginPath(); g.arc(x + 18, y - 12, 18, 0, Math.PI * 2); g.strokeStyle = '#dc2626'; g.lineWidth = 6; g.stroke(); }
            else pin(g, x + 18, y + 8, 16, it.color, false);
            g.fillStyle = '#0b1530'; g.font = font(700, 30); g.fillText(fit(it.t, lcW - 130), x + 52, y);
            g.fillStyle = '#64748b'; g.font = font(800, 30); g.textAlign = 'right'; g.fillText(String(it.n), x + lcW - 30, y); g.textAlign = 'left';
        });
        if (!legItems.length) { g.fillStyle = '#64748b'; g.font = font(600, 30); g.fillText('No stations placed on this plan yet.', pad + 50, ly + 136); }
        const dCols = land ? 4 : 2, dW = (pad + boxW - splitX - 100) / dCols;
        details.forEach(([key, val], i) => {
            const x = splitX + 50 + (i % dCols) * dW, y = ly + 128 + Math.floor(i / dCols) * 92;
            g.fillStyle = '#64748b'; g.font = font(800, 22); g.fillText(key.toUpperCase(), x, y);
            g.fillStyle = '#0b1530'; g.font = font(700, 31); g.fillText(fit(val, dW - 24), x, y + 40);
        });
        g.fillStyle = '#94a3b8'; g.font = font(600, 24); g.fillText(`Generated from the Pesties ${d.app || ''} · ${dayTime(Date.now())}`.replace('  ', ' '), pad, H - 40);
        // one A4 page, filled edge to edge
        const doc = new jsPDF({ orientation: land ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
        doc.addImage(c.toDataURL('image/jpeg', .9), 'JPEG', 0, 0, doc.internal.pageSize.getWidth(), doc.internal.pageSize.getHeight());
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
        const table = (cols, rows) => {
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
                doc.setTextColor(15, 23, 42);
                let x0 = M; cells.forEach((c, i) => { doc.text(c, x0 + 1.5, y + 3.9); x0 += widths[i]; });
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
        table(ENTRY_COLS, (v.entries || []).map(e => [e.name, e.barcode, e.type, e.activity === 'None' || !e.activity ? 'No activity' : e.activity, e.pests || '-', e.prep || '-', e.notes || '']));
        if ((v.recs || []).length) {
            heading('Recommendations raised');
            table(REC_COLS, v.recs.map(r => [r.no || '', r.status || '', day(r.raised), r.station || '', r.barcode || '', r.text || '', r.closed ? day(r.closed) : '', r.note || '']));
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
    return { build, logo, pestMap, pin };
})();
/* PESTIS-VISITPDF:END */
