/* PESTIS-CHANGELOG:BEGIN - "What's new" (identical in the Service App, Admin and the Client Portal; edit changelog_shared.js and run sync_changelog.py) */
// One list of every update, newest first. Each update says what changed in each app:
//   svc = Service App (index.html), adm = Admin (admin.html), cli = Client Portal (client.html - written for clients)
const WN = (() => {
    const LOG = [
        { rev: 'r72', date: '2026-10-23', v: { svc: '2026.10.23-r72' },
            svc: ['Site page: the site contact box is only as wide as it needs to be, and tapping anywhere on it opens all the contacts',
                  'Floor plan editor: dragging a wall moves the whole room (or the whole fence line) it belongs to',
                  'Floor plan editor: tap a wall once to select its room, tap it again to select just that wall - then dragging it moves only that wall, the walls either side stretch to follow and the room\'s colour fills the new shape',
                  'Floor plan editor: walls and corners that touch (rooms side by side, a fence meeting a wall) stay joined when you move one of them',
                  'Floor plan editor: walls drawn one by one and closed into a shape become a room, with a colour, that moves as one',
                  'Floor plan editor: with the move tool, drag a room, wall or object to move it; drag empty space to move around'] },
        { rev: 'r71', date: '2026-10-23', v: { cli: '2026.10.23-p31' },
            cli: ['Floor plans: the tab opens on a card for each plan (its picture, name and number of stations); tap a card to open the plan, and "‹ All floor plans" to go back'] },
        { rev: 'r70', date: '2026-10-23', v: { svc: '2026.10.23-r70', adm: '2026.10.23-a15', cli: '2026.10.23-p30' },
            svc: ['One sign-in for all three apps: switch to Admin or the Client Portal from your menu without signing in again',
                  'Using any Pestis app counts as activity, so you\'re not signed out of one while working in another',
                  'Station names can\'t be used twice on a site: naming or renaming a station to a name that\'s taken shows a warning and won\'t save'],
            adm: ['One sign-in for all three apps: switch to the Service App or the Client Portal from your menu without signing in again',
                  'Signed in with an account that isn\'t an admin: Admin says so and points to the right app, without signing you out of the others'],
            cli: ['Pesties staff: one sign-in for the Service App, Admin and the Client Portal',
                  'Your menu only shows the apps your account can use'] },
        { rev: 'r69', date: '2026-10-23', v: { svc: '2026.10.23-r69', adm: '2026.10.23-a14', cli: '2026.10.23-p29' },
            adm: ['Reports › One station: a line for each pest caught (or the activity level for external toxic stations), over the years',
                  'Reports: "Year on year" shows each year as its own line, January to December, to compare',
                  'Reports: drop-downs for stations, pests, preparations and floor plans you can type in to search',
                  'Reports: monthly charts (recommendations, visits) are line charts'],
            cli: ['Overview › Outstanding recommendations: a set height that scrolls, photo or list view, and − / + to make the cards smaller or bigger',
                  'Overview › Site contacts: as tall as the recommendations beside it, and scrolls',
                  'Overview › Pest activity: the pest, station and floor plan drop-downs can be searched by typing',
                  'Overview › Your stations: the same cards as the recommendations',
                  'Reports › Recommendations: tap an R number to open that recommendation',
                  'Reports › One station: search for the station, a line for each pest caught (or activity level for external bait stations) over the years, and "Show on floor plan"',
                  'Reports: "Year on year" shows each year as its own line, January to December, to compare',
                  'Reports: monthly charts are line charts'] },
        { rev: 'r68', date: '2026-10-23', v: { svc: '2026.10.23-r68', adm: '2026.10.23-a13', cli: '2026.10.23-p28' },
            svc: ["What's new: this page, listing every update (Settings › What's new)",
                  'Settings › Site page layout: choose how many boxes sit in each row, and reset the layout (moved here from the site page)',
                  'Site contacts added or changed in Admin or the Client Portal now show straight away on an open site'],
            adm: ["What's new: this page, listing every update (your menu, top right)",
                  'Reports › Last scanned: the time to the second, and tap a station to see its history',
                  'Reports › Preparations used: tap a preparation to open its safety data sheet (SDS)'],
            cli: ["What's new: this page, listing every update (your menu, top right)",
                  'Reports › Last scanned: the time each station was checked, to the second, and tap a station to see its history',
                  'Reports › Preparations used: tap a preparation to open its safety data sheet',
                  'The Preparations tab has gone: preparations are in Reports, and safety data sheets are in Documents › SDS'] },
        { rev: 'r67', date: '2026-10-23', v: { svc: '2026.10.23-r67', adm: '2026.10.23-a12', cli: '2026.10.23-p27' },
            svc: ['Site contacts: any number per site with their role, phone and email; the main contact shows on the site page with a phone number to tap',
                  'Floor plans: each plan shows how many of its stations are still to be placed; "Unpin all stations" to place them again; "Place here" is now "Place"',
                  'Settings: choose how many boxes sit in each row on the site page',
                  'Station and recommendation cards are all the same size again',
                  'The station pop-up after scanning lays out correctly again (notes, recommendations and Save were outside it)',
                  'Pest guide pictures load again',
                  'Phones: less space above the site card; the pin next to the site address has gone',
                  'Only admin accounts can change a site\'s picture',
                  'Links between the Service App, Admin and the Client Portal, and each says which app it is'],
            adm: ['Site contacts tab: add, change and remove each site\'s contacts, and choose the main contact',
                  'Links between the Service App, Admin and the Client Portal'],
            cli: ['Site contacts: keep the list of people at your site up to date (Overview › Site contacts)',
                  'Links to the other Pestis apps for Pesties staff'] },
        { rev: 'r66', date: '2026-10-22', v: { svc: '2026.10.22-r66' },
            svc: ['Opens with weak or no signal in a few seconds, using the copy saved on the phone',
                  '"Repair app" won\'t run without signal (it could have left the app unable to open)'] },
        { rev: 'r65', date: '2026-10-22', v: { svc: '2026.10.22-r65', adm: '2026.10.22-a11', cli: '2026.10.22-p26' },
            svc: ['Address search when adding or editing a site',
                  'Critical limits rebuilt: set by an admin for each site; going over a limit asks for a recommendation',
                  'Station cards show the station name and when it was last scanned; station type colours',
                  'Past visits: filter by technician',
                  'Needs action: contracts ending and floor plans due their yearly check',
                  'Phones: the scan screen\'s sections fold away',
                  'Barcode shown in the station details, with Change barcode beside the Map button'],
            adm: ['Critical limits tab: each site\'s own limits and the stations on them',
                  'Reports tab: the same nine reports as the Client Portal, with download for Excel and print',
                  'Station types have their own colours',
                  'Download a whole documents folder as a zip'],
            cli: ['New Reports tab: pest trends, pests found, busiest stations, one station\'s history, last scanned, preparations used, critical limits, recommendations and visits; each can be downloaded for Excel or printed',
                  'Critical limits now follow each site\'s own limits',
                  'Stations show in their type colours'] },
        { rev: 'r64', svc: ['Satellite floor plans: no more watermark on the picture'] },
        { rev: 'r63', svc: ['Floor plan text: bold, italic and font; a slider to turn items; labels start at size 100'],
            adm: ['Download all: a whole documents folder as a zip'],
            cli: ['Download all: a whole documents folder as a zip'] },
        { rev: 'r62', svc: ['Floor plans: the plan picker is a drop-down on desktop too',
                            'Rodent stations: "Bait eaten" is now "Activity", with a new "Caught" option',
                            'Phones: a more compact station form'] },
        { rev: 'r61', svc: ['Floor plan labels: type the text size',
                            'Past visits and the activity log: month and day headings fold away',
                            'Photo cards share one compact layout'] },
        { rev: 'r60', svc: ['Phones: the floor plan picker is a drop-down'] },
        { rev: 'r59', svc: ['"Satellite map" is an option when adding a floor plan'] },
        { rev: 'r58', svc: ['Satellite floor plans are saved much smaller'] },
        { rev: 'r57', svc: ['Satellite map: rotate it, use it at any zoom, and find an address as you type'] },
        { rev: 'r56', svc: ['Pest guide: Surinam, native bush and black (Māori bug) cockroaches',
                            'Settings moved into your profile',
                            'Phones: notifications and tasks share one pop-up with tabs'] },
        { rev: 'r55', svc: ['Past visits grouped by month',
                            'Floor plan editor: shapes, select several items to move together, independent rooms, a bigger page when needed, and a satellite map background',
                            'Photo cards all the same size'] }
    ];
    const APP = { svc: 'Service App', adm: 'Admin', cli: 'Client Portal' };
    const e = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const fmt = d => d ? new Date(d + 'T12:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const forApp = app => LOG.filter(x => x[app] && x[app].length);
    const KEY = app => 'pestis-whatsnew-seen-' + app;
    const seen = app => { try { return localStorage.getItem(KEY(app)) || ''; } catch (err) { return ''; } };
    const rank = rev => Number(String(rev || '').replace(/\D/g, '')) || 0;
    // updates for this app the person hasn't opened yet
    function unseen(app) { const s = rank(seen(app)); const list = forApp(app); return s ? list.filter(x => rank(x.rev) > s).length : (list.length ? 1 : 0); }
    function markSeen(app) { const l = forApp(app)[0]; if (l) { try { localStorage.setItem(KEY(app), l.rev); } catch (err) {} } badges(app); }
    function badges(app) { const n = unseen(app); document.querySelectorAll('[data-wn-badge]').forEach(b => { b.textContent = n ? 'New' : ''; b.style.display = n ? '' : 'none'; }); }
    function html(app) {
        const s = rank(seen(app));
        if (!document.getElementById('wnCss')) {
            const st = document.createElement('style'); st.id = 'wnCss';
            st.textContent = '.wn-list{display:flex;flex-direction:column;gap:.75rem}.wn-rev{border:1px solid var(--border);border-radius:.9rem;padding:.8rem 1rem;background:var(--surface2)}.wn-rev.wn-new{border-color:rgb(var(--b500))}'
                + '.wn-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:.25rem .6rem;margin-bottom:.35rem}.wn-h b{font-weight:900;color:var(--text)}.wn-h span{font-size:11px;color:var(--faint)}'
                + '.wn-tag{font-size:9.5px!important;font-weight:800;color:#fff!important;background:rgb(var(--b500));padding:0 .4rem;border-radius:999px}'
                + '.wn-rev ul{margin:0;padding-left:1.1rem;list-style:disc;font-size:12.5px;line-height:1.45;color:var(--text)}.wn-rev li+li{margin-top:.2rem}';
            document.head.appendChild(st);
        }
        const list = forApp(app);
        return `<div class="wn-list"><p style="font-size:12px;color:var(--muted);margin:0">What's changed in the ${e(APP[app])}, newest first. You're on <b>${e((list[0] && list[0].v && list[0].v[app]) || (list[0] && list[0].rev) || '')}</b>.</p>`
            + list.map(x => `<div class="wn-rev ${s && rank(x.rev) > s ? 'wn-new' : ''}"><div class="wn-h"><b>Update ${e(x.rev)}</b>${x.date ? `<span>${e(fmt(x.date))}</span>` : ''}${x.v && x.v[app] ? `<span>version ${e(x.v[app])}</span>` : ''}${s && rank(x.rev) > s ? '<span class="wn-tag">New</span>' : ''}</div>`
                + `<ul>${x[app].map(t => `<li>${e(t)}</li>`).join('')}</ul></div>`).join('') + '</div>';
    }
    return { LOG, html, unseen, markSeen, badges, latest: app => forApp(app)[0] };
})();
/* PESTIS-CHANGELOG:END */
