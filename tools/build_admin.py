# Builds admin.html as its own app: own login, own page, own code (nothing loaded from index.html).
import re, json, sys, tempfile
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + '/'
SP = ROOT + 'src/'
ADMIN_VERSION = '2026.10.30-a31-oci'   # bump the a-number when Admin changes
idx = open(ROOT + 'index.html').read()
src = open(SP + 'admin_src.html').read()          # the add-on version of admin.html (template + addonScript)

# ---------------- pieces of index.html ----------------
head = idx[idx.index('<head>') + 6: idx.index('</head>')]
head = head.replace('<title>Pestis - Enterprise Field Operations</title>', '<title>Pestis Admin</title>')
head = re.sub(r'\s*<!--[^>]*Html5Qrcode[^>]*-->\s*<script src="https://unpkg.com/html5-qrcode[^"]*"[^>]*></script>', '\n', head)
head = re.sub(r'\s*<!--[^>]*jsPDF[^>]*-->\s*<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf[^"]*"></script>', '\n', head)
assert 'html5-qrcode' not in head and 'jspdf' not in head, 'cdn strip'
mstart = idx.index('const SUPABASE_URL')
main = idx[idx.rfind('<script>', 0, mstart) + 8: idx.index('</script>', mstart)]   # the app's own script only (not the shared What's new list after it)
L = main.split('\n')
defs = {}
for i, l in enumerate(L):
    m = re.match(r'^        (?:async )?function ([A-Za-z_$][\w$]*)\s*\(', l) or re.match(r'^        (?:const|let|var) ([A-Za-z_$][\w$]*)\b', l)
    if m and m.group(1) not in defs: defs[m.group(1)] = i
def block_end(i):
    depth = 0; started = False; j = i
    while True:
        l = re.sub(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"", '', L[j])
        l = re.sub(r'/(?:\\.|[^/\\\n])+/[gimsuy]*', '', l) if 'test(' in l or '.replace(' in l or '.match(' in l else l
        for ch in l:
            if ch in '{[(': depth += 1; started = True
            elif ch in '}])': depth -= 1
        if (started and depth <= 0) or (not started and L[j].rstrip().endswith(';')): return j
        j += 1
WANT = '''DEFAULT_OPTIONS,stationColorBase,stationColor,DOC_BUCKET,DOC_CATEGORIES,LOCALE,NONE_PREP,NONE_SPECIES,OPTION_INPUT,OPTION_KIND_LABEL,PEST_CATEGORIES,PEST_CAT_ICON,PHOTO_BUCKET,
PORTAL_SQL_NOTE,PREP_UNITS,TEAM_SETTINGS,autoFillPest,byLabel,compressImage,cssEsc,docExpiryChip,docFolderOf,docsNeedingAttention,dueInfo,esc,extFor,findPest,
fmtDateTimeLong,fmtDay,fmtRecNo,freqLabel,getServices,getSignedUrls,isWebPic,monthWork,monthWorkSummaryHtml,openMonthWork,parseDay,pestCategories,pestCategoryGuess,
pestCategoryOf,pestLibraryFor,portalMissing,portalUrl,prepSdsChip,openPrepSds,showPestInfo,siteById,speciesItems,teamName,technicianLabel,toDayStr,todayStr,typeDot,uid,
unitText,userSettingFields,userSettingRead,userSettingWrite,visitAgeText,visitInfo,withTimeout,saveJSON,loadJSON,teamSetting,adminLoadUserSettings,adminSaveUserSettings,
fillAdminDocFolders,sitePickUsers,contractInfo,openInfoModal,closeInfoModal,openPestGuide,renderPestGuideList,coverUrl,txt,hashString,CARD_GRADIENTS,adminData,clientUpdates,
pestSubOf,pestSubs,PEST_SUB_ORDER,isGeneralPest,pestGallery,findPestGallery,commonsSearch,drawPestGallery,pgStep,pgOpenFull,pestGalleryHtml,pgState,LIST_TABLES,LIST_EXTRA_COLS,
toDbClientFields,mergeClients,normalizeClientRow,learnClientColumns,saveSiteDocument,FREQUENCIES,FREQ_MAP,pestGuideOf,wikiPestInfo,PEST_LIBRARY,PEST_CATEGORY_TEXT,
SCAN_SOUNDS,SCAN_VIBES,PHOTO_PRESETS,RENEWAL_WARN_DAYS,VISIT_STALE_HOURS,teamSettings,teamMembers,addFrequency,MONTH_SHORT,freqMonths,freqSelectValue,firstChosenDue,setServiceFrequency,toggleServiceMonth,monthPickerHtml,dueMonth,STANDARD_FOLDERS,copyPortalLink,newDocFolder,safely,adminProfiles,adminAllowed'''.replace('\n', '').split(',')
SKIP = set('''_supabase,enqueue,queueItems,currentUser,currentProfile,isOnline,appOptions,clientsData,selectedClient,addon,isAdmin,isAdminUser,queueSiteChange,startSiteVisit,
openRecModal,openServicesModal,loadOptions,populateOptionSelects,cacheSet,updateSyncBadge,removeQueueItem,applyTeamSettings,buildNotifications,logAppError,acctApply,
acctCacheKey,renderSiteCards,renderNotifications,loadSiteDocs,closeAdmin,showSiteDashboard,mwOpenSite,sessionSet,sessionGet,flushQueue,siteDocs,siteDocFolders,
loadClientUpdates,openAdmin,addonMissing,viewFullImage,showViewerPhoto,applyZoom,resetZoom,zoom,ZOOM_MAX,viewerIndex,viewerNote,viewerSrcs,loadBellExtras,siteSetup,
appStarted,notifBreaches,notifDocs,notifSightings,notifUnplaced,cardErrors,refreshLandingHeader,renderSiteDocs,populateSiteFilter,ADMIN_MODE,
SUPABASE_URL,SUPABASE_ANON_KEY,LIMITS_ON,photoPreset'''.replace('\n', '').split(','))
have = {}
queue = list(WANT)
while queue:
    n = queue.pop()
    if n in have or n in SKIP or n not in defs: continue
    i = defs[n]; a = i
    while a > 0 and L[a - 1].strip().startswith('//') and not L[a - 1].strip().startswith('// ==='): a -= 1
    b = block_end(i)
    txt = '\n'.join(L[a:b + 1]); have[n] = (a, b, txt)
    for u in set(re.findall(r'\b([A-Za-z_$][\w$]*)\b', re.sub(r'//[^\n]*', '', txt))):
        if u in defs and u not in have and u not in SKIP: queue.append(u)
# blocks in their original order, without repeats (one block may define several names)
blocks = sorted({(a, b) for a, b, _ in have.values()})
merged = []
for a, b in blocks:
    if merged and a <= merged[-1][1]: merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
    else: merged.append((a, b))
# each block must be complete JavaScript: grow it until it is (the brace counter can be fooled by quotes in regexes)
import subprocess
def ok_js(txt):
    f = os.path.join(tempfile.gettempdir(), 'pestis-blk.js'); open(f, 'w').write(txt)
    return subprocess.run(['node', '--check', f], capture_output=True).returncode == 0
fixed = []
for a, b in merged:
    e = b
    while not ok_js('\n'.join(L[a:e + 1])) and e < b + 60: e += 1
    assert ok_js('\n'.join(L[a:e + 1])), ('cannot complete block', a, L[a][:80])
    if fixed and a <= fixed[-1][1]: fixed[-1] = (fixed[-1][0], max(e, fixed[-1][1]))
    else: fixed.append((a, e))
merged = fixed
core = '\n\n'.join('\n'.join(L[a:b + 1]) for a, b in merged)
cfg = '\n'.join(l for l in L if l.strip().startswith('const SUPABASE_URL') or l.strip().startswith('const SUPABASE_ANON_KEY'))
print('core defs', len(have), 'blocks', len(merged), 'chars', len(core), file=sys.stderr)

# ---------------- pieces of the add-on admin.html ----------------
style = re.search(r'<style>([\s\S]*?)</style>', src).group(1)
markup = re.search(r'<template id="addonMarkup">([\s\S]*?)</template>', src).group(1)
code = re.search(r'<script type="text/plain" id="addonScript">([\s\S]*?)</script>', src).group(1)
info_modal = idx[idx.index('    <div id="infoModal"'): idx.index('\n\n', idx.index('    <div id="infoModal"'))]
watchdog = idx[idx.index('    <!-- Start-up watchdog'): idx.index('    </script>\n', idx.index('    <!-- Start-up watchdog')) + 14]
watchdog = watchdog.replace("'toggleTheme'", "'adminBoot'").replace('typeof window.toggleTheme', 'typeof window.adminBoot').replace('index.html never loaded', 'admin.html never loaded').replace('Pestis is taking longer', 'Pestis Admin is taking longer').replace('end of index.html', 'end of admin.html').replace('whole index.html', 'whole admin.html')

def R(s, a, b, cnt=1):
    assert s.count(a) == cnt, (s.count(a), a[:140]); return s.replace(a, b)

# the admin page is the page (not a layer over the Service App); its header has the person and Sign out
markup = R(markup, '''    <div id="adminPage" class="hidden fixed inset-0 z-[55] overflow-y-auto scroll-thin" style="background: var(--bg);">''',
                   '''    <div id="adminPage" class="hidden min-h-screen" style="background: var(--bg);">''')
markup = R(markup, '''                <button type="button" onclick="closeAdmin()" class="btn btn-secondary !px-3" title="Go to the sites">← Sites</button>
                <div class="min-w-0 flex-1">
                    <div class="eyebrow t-accent">Pestis</div>
                    <h2 class="text-lg font-black t-strong leading-tight">🛡 Admin</h2>
                </div>
                <button type="button" onclick="refreshAdmin()" class="btn btn-secondary !px-3" title="Load the latest">⟳ <span class="hidden sm:inline">Refresh</span></button>''',
'''                <div class="logo-tile shrink-0"><img src="images/pesties-logo.png" alt="Pesties" class="h-8 w-auto object-contain rounded"></div>
                <div class="min-w-0 flex-1">
                    <div class="eyebrow t-accent">Pestis</div>
                    <h2 class="text-lg font-black t-strong leading-tight">🛡 Admin</h2>
                </div>
                <button type="button" onclick="refreshAdmin()" class="btn btn-secondary !px-3" title="Load the latest">⟳ <span class="hidden sm:inline">Refresh</span></button>
                <button type="button" onclick="toggleTheme()" class="icon-btn" title="Day / night mode" aria-label="Day / night mode">◐</button>
                <div class="relative">
                    <button type="button" id="adminMeBtn" onclick="document.getElementById('adminMeMenu').classList.toggle('hidden')" class="flex items-center gap-2 rounded-xl pl-1 pr-3 h-10" style="background: var(--surface3); border: 1px solid var(--border);" aria-haspopup="menu">
                        <img id="adminMeAvatar" src="" alt="" class="w-8 h-8 rounded-lg object-cover hidden" referrerpolicy="no-referrer">
                        <span id="adminMeInitial" class="w-8 h-8 rounded-lg bg-brand-500 text-white font-black text-xs flex items-center justify-center">?</span>
                        <span id="adminMeName" class="text-xs font-bold t-strong hidden sm:block max-w-[9rem] truncate"></span>
                    </button>
                    <div id="adminMeMenu" class="hidden absolute right-0 mt-2 w-64 card p-3 space-y-2 text-xs z-50" role="menu">
                        <div id="adminMeDetail" class="t-muted break-words"></div>
                        <div class="text-[10px] t-faint">Pestis Admin <span class="addon-version font-mono"></span></div>
                        <button type="button" onclick="document.getElementById('adminMeMenu').classList.add('hidden'); openWhatsNew()" class="btn btn-secondary w-full">✨ What's new<span data-wn-badge class="wn-badge" style="display:none"></span></button>
                        <div class="border-t divider pt-2 space-y-1.5"><div class="app-here">Pestis apps · you're in Admin</div><nav class="app-switch" aria-label="Pestis apps"><a href="index.html">🛠 Service App</a><span class="on" aria-current="page">🛡 Admin</span><a href="client.html">🏢 Client Portal</a></nav></div>
                        <button type="button" onclick="signOut()" class="btn btn-secondary w-full">Sign out</button>
                    </div>
                </div>''')
markup = R(markup, '''<div id="adminOffline" class="hidden card p-4 text-xs" style="color:#d97706;">You're offline. The Admin page needs a connection to load and save.</div>''',
                   '''<div id="adminOffline" class="hidden card p-4 text-xs" style="color:#d97706;">You're offline. The Admin site needs a connection to load and save.</div>''')

LOGIN = '''
    <!-- ===================== SIGN IN (admins only) ===================== -->
    <div id="loginScreen" class="fixed inset-0 z-[70] flex items-center justify-center p-6" style="background: var(--bg);">
        <button type="button" onclick="toggleTheme()" class="icon-btn absolute top-4 right-4" title="Day / night mode" aria-label="Day / night mode">◐</button>
        <div class="card p-8 max-w-sm w-full text-center space-y-5">
            <div class="logo-tile mx-auto"><img src="images/pesties-logo.png" alt="Pesties" class="w-52 max-w-full object-contain rounded-lg"></div>
            <div><div class="eyebrow t-accent">Pestis</div><h1 class="text-2xl font-black t-strong">🛡 Admin</h1></div>
            <p id="authLoading" class="text-xs t-muted italic">Checking your sign-in...</p>
            <div id="loginPanel" class="hidden space-y-4">
                <p class="text-xs t-muted">For Pestis administrators. Sign in with your admin Google account.</p>
                <button type="button" onclick="signInWithGoogle()" class="btn btn-white w-full !py-3 !text-sm">
                    <svg class="w-5 h-5" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
                    Sign in with Google
                </button>
                <p class="text-[11px] t-faint">Technicians use the Service App. Clients use the Client Portal.</p>
            </div>
            <p id="loginMessage" class="text-xs hidden leading-relaxed" style="color:#ef4444;"></p>
            <div class="space-y-1.5 border-t divider pt-4"><div class="app-here">Pestis apps</div><nav class="app-switch" aria-label="Pestis apps"><a href="index.html">🛠 Service App</a><span class="on" aria-current="page">🛡 Admin</span><a href="client.html">🏢 Client Portal</a></nav></div>
        </div>
    </div>
'''
EXTRA_MODALS = '''
    <!-- a site's services and schedule (admins add and remove them here) -->
    <div id="svcModal" class="hidden overlay fixed inset-0 z-[64] flex justify-center items-center p-4" onclick="if (event.target === this) closeAdminServices()">
        <div class="card w-full max-w-2xl p-5 sm:p-6 space-y-3 overflow-y-auto scroll-thin" style="max-height: 92vh;">
            <div class="flex items-start justify-between gap-2"><div><div class="eyebrow t-accent">Services &amp; schedule</div><h3 id="svcTitle" class="text-lg font-black t-strong"></h3></div>
                <button type="button" class="icon-btn" onclick="closeAdminServices()" aria-label="Close">✕</button></div>
            <div id="svcList" class="space-y-2 text-xs"></div>
            <button type="button" class="btn btn-secondary" onclick="svcAdd()">+ Add a service</button>
            <div class="flex gap-2 pt-1"><button type="button" class="btn btn-secondary" onclick="closeAdminServices()">Cancel</button><button type="button" id="svcSaveBtn" class="btn btn-primary ml-auto" onclick="saveAdminServices()">Save</button></div>
        </div>
    </div>

    <!-- full-screen photos with arrows -->
    <div id="lightbox" class="hidden fixed inset-0 z-[80] flex flex-col items-center justify-center gap-3 p-4" style="background: rgba(2, 6, 23, .94);" onclick="if (event.target === this) closeLightbox()">
        <div id="lbTitle" class="text-white font-bold text-sm text-center"></div>
        <div class="relative w-full max-w-5xl flex items-center justify-center">
            <button type="button" id="lbPrev" class="pg-nav pg-prev" onclick="lbStep(-1)" aria-label="Previous">‹</button>
            <img id="lbImg" src="" alt="" class="max-h-[78vh] max-w-full rounded-xl object-contain">
            <button type="button" id="lbNext" class="pg-nav pg-next" onclick="lbStep(1)" aria-label="Next">›</button>
        </div>
        <div class="flex items-center gap-3"><span id="lbCount" class="text-xs text-white/80 font-mono"></span><button type="button" class="btn btn-secondary !py-1.5" onclick="closeLightbox()">Close</button></div>
    </div>
'''

SYSTEM = r'''
        // ===================================================================
        //  PESTIS ADMIN - its own site, with its own sign-in. Nothing here is shared with the Service App
        //  (index.html) or the Client Portal (client.html); they only share the database.
        // ===================================================================
        window.adminBoot = true;
''' + cfg + r'''
        const ADMIN_MODE = true;
        const LIMITS_ON = false;
        const SERVICE_APP_PAGE = 'index.html';
        // One sign-in for the three Pestis apps (Service App, Admin, Client Portal - the same website and database):
        // signing in to one signs you in to the others. Each app still checks for itself that the account may use it,
        // and the database rules decide what each account can see. The key is the Service App's, so its sign-ins carry over.
        const PESTIS_AUTH_KEY = 'sb-' + SUPABASE_URL.replace(/^https?:\/\//, '').split('.')[0] + '-auth-token';
        function pestisAdoptSignIn(oldKey) {   // a sign-in saved by an older version of this app (under its own key) is kept, once
            try { const v = localStorage.getItem(oldKey); if (v && !localStorage.getItem(PESTIS_AUTH_KEY)) localStorage.setItem(PESTIS_AUTH_KEY, v); localStorage.removeItem(oldKey); } catch (e) {}
        }
        // "Not used for a while" counts activity in any Pestis app, so working in one doesn't sign you out of another
        const PESTIS_ACTIVE_KEY = 'pestis-last-active';
        let pestisActiveWritten = 0;
        function pestisMarkActive() { const t = Date.now(); if (t - pestisActiveWritten < 5000) return; pestisActiveWritten = t; try { localStorage.setItem(PESTIS_ACTIVE_KEY, String(t)); } catch (e) {} }
        function pestisLastActive() { try { return Number(localStorage.getItem(PESTIS_ACTIVE_KEY)) || 0; } catch (e) { return 0; } }

        pestisAdoptSignIn('sb-pestis-admin-auth-token');
        const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: { storageKey: PESTIS_AUTH_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, lock: async (name, t, fn) => await fn() }
        });
        let currentUser = null, currentProfile = null, isOnline = navigator.onLine, appStarted = false;
        let appOptions = [], clientsData = [], selectedClient = null, queueItems = [], optionsLoadError = '', optionsUnitMissing = false, cardErrors = [];
        window.addEventListener('online', () => { isOnline = true; const o = document.getElementById('adminOffline'); if (o) o.classList.add('hidden'); });
        window.addEventListener('offline', () => { isOnline = false; const o = document.getElementById('adminOffline'); if (o) o.classList.remove('hidden'); });
        const isAdmin = () => !!(currentProfile && currentProfile.role === 'admin');
        const isAdminUser = isAdmin;
        function addon(name, ...args) { const f = window[name]; return typeof f === 'function' ? f(...args) : undefined; }
        function logAppError(where, e) { console.warn(where, e); }
        function updateSyncBadge() {}
        function renderSiteCards() {}
        function renderNotifications() {}
        function populateOptionSelects() {}
        async function cacheSet() {}
        async function removeQueueItem() {}
        function flushQueue() {}
        function loadSiteDocs() {}
        const acctCacheKey = () => 'pestis-admin-acct';
        function acctApply() {}
        function photoPreset() { return Object.assign({ key: 'balanced' }, PHOTO_PRESETS.balanced); }
        const sessionGet = k => { try { return sessionStorage.getItem(k); } catch (e) { return null; } };
        const sessionSet = (k, v) => { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) {} };
        function applyTeamSettings() { RENEWAL_WARN_DAYS = teamSetting('renewal_warn_days'); VISIT_STALE_HOURS = teamSetting('visit_stale_hours'); }
        function toggleTheme() {
            const dark = !document.documentElement.classList.contains('dark');
            document.documentElement.classList.toggle('dark', dark);
            try { localStorage.setItem('pestis-theme', dark ? 'dark' : 'light'); } catch (e) {}
        }

        // ---------- saving: the Admin site writes straight to the database (it needs a connection) ----------
        async function enqueue(item) {
            if (!navigator.onLine) { alert("You're offline. The Admin site saves straight to the database, so try again when you're back online."); throw new Error('offline'); }
            const d = item.data || {};
            let res = null;
            if (item.kind === 'add_option' || item.kind === 'delete_option') {
                const table = LIST_TABLES[d.kind];
                if (item.kind === 'delete_option') res = await _supabase.from(table).delete().eq('id', d.id);
                else {
                    const extra = {}, cols = LIST_EXTRA_COLS[d.kind] || [];
                    cols.forEach(c => { if (d[c] !== undefined) extra[c] = d[c]; });
                    const base = Object.assign({ id: d.id, label: d.label, sort: d.sort || 0 }, d.kind === 'prep' ? { unit: d.unit || 'each' } : {});
                    res = await _supabase.from(table).upsert([Object.assign({}, base, extra)], { onConflict: 'id' });
                    if (res.error && Object.keys(extra).length && cols.some(c => (res.error.message || '').includes(c))) {
                        res = await _supabase.from(table).upsert([base], { onConflict: 'id' });
                        if (!res.error) alert('Saved, but the SDS / pest guide details need pestis_client_portal.sql to be run on the Pestis server (it updates the database itself when it restarts).');
                    }
                }
            } else if (item.kind === 'save_setting') {
                res = await _supabase.from('app_settings').upsert([{ key: d.key, value: d.value, updated_at: new Date().toISOString() }], { onConflict: 'key' });
            } else if (item.kind === 'table_upsert') {
                res = await _supabase.from(d.table).upsert([d.row], { onConflict: 'id' });
            } else if (item.kind === 'update_client') {
                res = await _supabase.from('clients').update(toDbClientFields(d.fields)).eq('id', item.clientId);
            } else { console.warn('Not saved here:', item.kind); return item; }
            if (res && res.error) { alert(`${item.label || 'Saving'} - could not save: ${res.error.message}`); throw res.error; }
            return item;
        }
        async function queueSiteChange(change, label) {
            const c = change.client_id ? siteById(change.client_id) : selectedClient;
            if (!c) return;
            const now = new Date().toISOString();
            return enqueue({ kind: 'table_upsert', label: label || change.title, data: { table: 'site_events', row: { id: uid(), client_id: String(c.id), action: change.action || 'change', title: change.title, detail: change.detail || null, station: change.station || null, technician: technicianLabel(), at: now } } }).catch(() => {});
        }

        // ---------- loading ----------
        async function loadClients() {
            const { data, error } = await withTimeout(_supabase.from('clients').select('*').order('Name', { ascending: true }), 15000, 'Loading sites');
            if (error) throw error;
            learnClientColumns(data || []);
            mergeClients(data || []);
        }
        async function loadOptions() {
            try {
                const res = await Promise.all(Object.entries(LIST_TABLES).map(([kind, table]) => _supabase.from(table).select('*').order('sort', { ascending: true })
                    .then(r => { if (r.error) throw r.error; return (r.data || []).map(o => Object.assign({}, o, { id: o.id, kind, label: o.label, sort: o.sort || 0, unit: o.unit || undefined })); })));
                appOptions = res.flat(); optionsLoadError = '';
            } catch (e) { optionsLoadError = 'Could not load the lists: ' + (e.message || e); }
            if (typeof renderSettingsLists === 'function' && adminTab === 'lists') renderSettingsLists();
        }
        async function loadTeamSettings() {
            try { const { data } = await _supabase.from('app_settings').select('*'); (data || []).forEach(r => { teamSettings[r.key] = r.value; }); } catch (e) {}
            applyTeamSettings();
        }
        async function loadClientUpdates() {
            try {
                const since = new Date(Date.now() - 30 * 86400000).toISOString();
                const { data, error } = await _supabase.from('recommendation_updates').select('id, rec_id, client_id, status, note, photos, technician, at').eq('by_client', true).gte('at', since).order('at', { ascending: false }).limit(200);
                if (error) throw error;
                const ids = Array.from(new Set((data || []).map(u => u.rec_id)));
                let recs = [];
                if (ids.length) { const r = await _supabase.from('recommendations').select('id, rec_no, text, station_name').in('id', ids); recs = r.data || []; }
                clientUpdates = (data || []).map(u => Object.assign({}, u, { rec: recs.find(r => r.id === u.rec_id) || null }));
            } catch (e) { clientUpdates = []; }
        }
        // what needs attention across every site
        function buildNotifications() {
            const missed = [], dueSoon = [], contracts = [], longVisits = [];
            clientsData.forEach(c => {
                const v = visitInfo(c);
                if (v && v.stale) longVisits.push({ c, v });
                getServices(c).forEach(sv => { const d = dueInfo(sv); if (d.days !== null && d.days < 0) missed.push({ c, sv, days: d.days }); });
                const ci = contractInfo(c);
                if (ci && ci.days <= RENEWAL_WARN_DAYS) contracts.push({ c, ci });
            });
            missed.sort((a, b) => a.days - b.days); contracts.sort((a, b) => a.ci.days - b.ci.days); longVisits.sort((a, b) => b.v.hours - a.v.hours);
            return { missed, dueSoon, contracts, longVisits };
        }

        // ---------- a site's records live in the Service App: open it there (in a new tab) ----------
        function openInServiceApp(cid, rec) {
            const url = `${SERVICE_APP_PAGE}#site=${encodeURIComponent(cid)}${rec ? '&rec=' + encodeURIComponent(rec) : ''}`;
            window.open(url, '_blank', 'noopener');
        }
        function startSiteVisit(cid) { openInServiceApp(cid); return Promise.resolve(); }
        function mwOpenSite(cid) { openInServiceApp(cid); }
        function openRecModal() {}
        function findRec() { return null; }
        function openServicesModal() { if (selectedClient) openAdminServices(selectedClient.id); }

        // ---------- full-screen photos ----------
        let lb = { srcs: [], i: 0 };
        function viewFullImage(srcs, text, title, note, start) {
            lb = { srcs: (Array.isArray(srcs) ? srcs : [srcs]).filter(Boolean), i: start || 0 };
            document.getElementById('lbTitle').textContent = title || '';
            document.getElementById('lightbox').classList.remove('hidden');
            lbDraw();
        }
        function lbDraw() {
            document.getElementById('lbImg').src = lb.srcs[lb.i] || '';
            document.getElementById('lbCount').textContent = lb.srcs.length > 1 ? `${lb.i + 1} / ${lb.srcs.length}` : '';
            ['lbPrev', 'lbNext'].forEach(id => document.getElementById(id).classList.toggle('hidden', lb.srcs.length < 2));
        }
        function lbStep(d) { if (!lb.srcs.length) return; lb.i = (lb.i + d + lb.srcs.length) % lb.srcs.length; lbDraw(); }
        function closeLightbox() { document.getElementById('lightbox').classList.add('hidden'); }
        document.addEventListener('keydown', e => {
            if (!document.getElementById('lightbox').classList.contains('hidden')) { if (e.key === 'Escape') closeLightbox(); if (e.key === 'ArrowLeft') lbStep(-1); if (e.key === 'ArrowRight') lbStep(1); }
        });
        document.addEventListener('click', e => { if (!e.target.closest('#adminMeMenu') && !e.target.closest('#adminMeBtn')) { const m = document.getElementById('adminMeMenu'); if (m) m.classList.add('hidden'); } });

        // ---------- a site's services and schedule ----------
        let svcEdit = { cid: null, list: [] };
        function openAdminServices(cid) {
            const c = siteById(cid);
            if (!c) return;
            svcEdit = { cid: String(cid), list: getServices(c).map(s => Object.assign({}, s)) };
            document.getElementById('svcTitle').textContent = c.Name || 'Site';
            renderAdminServiceRows();
            document.getElementById('svcModal').classList.remove('hidden');
        }
        function closeAdminServices() { document.getElementById('svcModal').classList.add('hidden'); }
        function svcAdd() { svcEdit.list.push({ id: uid(), type: '', frequency: 'monthly', lastDone: '', nextDue: '', notes: '' }); renderAdminServiceRows(); }
        function svcSet(i, k, v) {
            const s = svcEdit.list[i]; if (!s) return;
            if (k === 'frequency') { setServiceFrequency(s, v); renderAdminServiceRows(); return; }
            s[k] = v;
            if (k === 'lastDone' && v && s.frequency && (FREQ_MAP[s.frequency] || freqMonths(s.frequency))) { s.nextDue = addFrequency(v, s.frequency) || s.nextDue; renderAdminServiceRows(); }
        }
        function svcMonth(i, n) { const s = svcEdit.list[i]; if (!s) return; toggleServiceMonth(s, n); renderAdminServiceRows(); }
        function renderAdminServiceRows() {
            document.getElementById('svcList').innerHTML = svcEdit.list.map((s, i) => `<div class="row-item p-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div class="sm:col-span-2 flex gap-2"><input class="field !py-2" placeholder="Service, e.g. Routine Service" value="${esc(s.type || '')}" oninput="svcSet(${i}, 'type', this.value)"><button type="button" class="btn btn-secondary !px-3" onclick="svcEdit.list.splice(${i}, 1); renderAdminServiceRows()" title="Remove" aria-label="Remove">✕</button></div>
                <label class="space-y-1"><span class="lbl !mb-0">How often</span><select class="field !py-2" onchange="svcSet(${i}, 'frequency', this.value)">${FREQUENCIES.map(f => `<option value="${f.v}" ${freqSelectValue(s.frequency) === f.v ? 'selected' : ''}>${esc(f.l || f.label || f.v)}</option>`).join('')}</select></label>
                ${freqMonths(s.frequency) ? `<div class="sm:col-span-2">${monthPickerHtml(s.frequency, n => `svcMonth(${i}, ${n})`)}</div>` : ''}
                <label class="space-y-1"><span class="lbl !mb-0">Last done</span><input type="date" class="field !py-2" value="${esc(s.lastDone || '')}" onchange="svcSet(${i}, 'lastDone', this.value)"></label>
                <label class="space-y-1"><span class="lbl !mb-0">Next due</span><input type="date" class="field !py-2" value="${esc(s.nextDue || '')}" onchange="svcSet(${i}, 'nextDue', this.value)"></label>
                <label class="space-y-1 sm:col-span-2"><span class="lbl !mb-0">Notes for the technician</span><textarea class="field !py-2" rows="2" oninput="svcSet(${i}, 'notes', this.value)">${esc(s.notes || '')}</textarea></label></div>`).join('') || '<div class="row-item p-3 t-faint italic">No services yet.</div>';
        }
        async function saveAdminServices() {
            const c = siteById(svcEdit.cid);
            if (!c) return;
            const cleaned = svcEdit.list.filter(s => String(s.type || '').trim()).map(s => Object.assign({}, s, { type: String(s.type).trim() }));
            const btn = document.getElementById('svcSaveBtn'); btn.disabled = true;
            try {
                await enqueue({ kind: 'update_client', clientId: c.id, label: 'Services updated', data: { fields: { services: cleaned } } });
                c.services = cleaned;
                await queueSiteChange({ client_id: c.id, action: 'services_edit', title: 'Services & schedule updated', detail: cleaned.map(x => `${x.type} (${freqLabel(x.frequency)}${x.nextDue ? ', next ' + fmtDay(x.nextDue) : ''})`).join(', ') || 'All services removed' });
                closeAdminServices();
                renderAdminTab();
            } catch (e) {} finally { btn.disabled = false; }
        }

        // ---------- sign in ----------
        function showLoginPanel(msg) {
            document.getElementById('loginScreen').classList.remove('hidden');
            document.getElementById('adminPage').classList.add('hidden');
            document.getElementById('authLoading').classList.add('hidden');
            document.getElementById('loginPanel').classList.remove('hidden');
            const m = document.getElementById('loginMessage');
            m.textContent = msg || ''; m.classList.toggle('hidden', !msg);
        }
        async function signInWithGoogle() {
            const { error } = await _supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } } });
            if (error) showLoginPanel('Sign-in failed: ' + error.message);
        }
        async function signOut() {
            try { await withTimeout(_supabase.auth.signOut({ scope: 'local' }), 5000, 'Sign out'); } catch (e) {}
            location.href = location.origin + location.pathname;
        }
        async function useDifferentAccount() { try { await withTimeout(_supabase.auth.signOut({ scope: 'local' }), 5000, 'Sign out'); } catch (e) {} location.href = location.origin + location.pathname; }
        async function startAdmin(session) {
            currentUser = session.user;
            const { data: profile, error } = await withTimeout(_supabase.from('profiles').select('*').eq('id', currentUser.id).maybeSingle(), 12000, 'Profile lookup');
            if (error) throw error;
            if (!profile || !profile.approved || profile.role !== 'admin') {
                // not signed out: the same sign-in is used by the other Pestis apps
                const email = currentUser.email;
                currentUser = null;
                showLoginPanel(`You're signed in as ${email}, which isn't an admin account.`);
                const m = document.getElementById('loginMessage');
                m.insertAdjacentHTML('beforeend', `<div class="mt-2">${profile && profile.approved ? '<a href="index.html" class="link-btn">Open the Service App</a>' : '<a href="client.html" class="link-btn">Open the Client Portal</a>'}</div><div class="mt-3"><button type="button" class="btn btn-secondary w-full" onclick="useDifferentAccount()">Sign in with a different account</button></div>`);
                return;
            }
            currentProfile = profile;
            appStarted = true;
            try { BOARD.attach(document.getElementById('adminBoard'), 'pestis-admin-overview-board', { attention: 2 / 3, workload: 1 / 3 }); } catch (e) {}
            const name = profile.full_name || currentUser.email;
            document.getElementById('adminMeInitial').textContent = name.trim().charAt(0).toUpperCase();
            document.getElementById('adminMeName').textContent = name;
            // the Google account's picture, like the Service App
            const pic = profile.avatar_url || (currentUser.user_metadata || {}).avatar_url || '';
            const av = document.getElementById('adminMeAvatar'), ini = document.getElementById('adminMeInitial');
            av.onload = () => { av.classList.remove('hidden'); ini.classList.add('hidden'); };
            av.onerror = () => { av.classList.add('hidden'); ini.classList.remove('hidden'); };
            if (pic) av.src = pic;
            document.getElementById('adminMeDetail').innerHTML = `<b class="t-strong">${esc(name)}</b><br>${esc(currentUser.email)}`;
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('adminPage').classList.remove('hidden');
            await Promise.all([loadClients().catch(e => { adminData.errors.sites = e.message || String(e); }), loadOptions(), loadTeamSettings()]);
            openAdmin(sessionGet('pestis-admin-route') || 'overview');
            refreshAdmin();
        }
        async function bootAdmin() {
            let session = null;
            try { session = (await withTimeout(_supabase.auth.getSession(), 10000, 'Session check')).data.session; } catch (e) {}
            if (!session) { showLoginPanel(''); return; }
            try { await startAdmin(session); } catch (e) { showLoginPanel('Could not start: ' + (e.message || e)); }
        }
        _supabase.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_IN' && session && !appStarted && !currentUser) startAdmin(session).catch(e => showLoginPanel('Could not start: ' + (e.message || e)));
            if (event === 'SIGNED_OUT' && appStarted) { appStarted = false; location.href = location.origin + location.pathname; }   // signed out in another Pestis app
        });

'''

# ---------------- the admin code: adjust for a site of its own ----------------
code = R(code, '''        window.ADDON_INFO = { name: 'Admin', version: '2026.10.22-a4', api: 1 };''', '''        window.ADDON_INFO = { name: 'Pestis Admin', version: ''' + "'" + ADMIN_VERSION + "'" + ''', api: 0 };''')
# openAdmin: just show a tab
code = re.sub(r"        function openAdmin\(tab\) \{\n[\s\S]*?\n        \}\n        function closeAdmin\(\) \{\n[\s\S]*?\n        \}\n",
              "        function openAdmin(tab) { setAdminTab(tab || adminTab); }\n        function closeAdmin() {}\n", code, count=1)
assert 'function openAdmin(tab) { setAdminTab' in code
code = re.sub(r"        function goToSite\(cid, then\) \{\n[\s\S]*?\n        \}\n", "        function goToSite(cid) { openInServiceApp(cid); }\n", code, count=1)
assert 'function goToSite(cid) { openInServiceApp(cid); }' in code
code = R(code, '''        function openAdminActivity(cid, rec) { goToSite(cid, rec ? () => { if (findRec(rec)) openRecModal(rec); } : null); }''',
               '''        function openAdminActivity(cid, rec) { openInServiceApp(cid, rec || null); }''')
code = R(code, '''onclick="goToSite(this.dataset.cid, () => openServicesModal())">Manage services</button>''', '''onclick="openAdminServices(this.dataset.cid)">Manage services</button>''')
code = R(code, '''            Object.assign(adminData, { recs, docs, events, loadedAt: Date.now() });
            adminProfiles = profs;''', '''            Object.assign(adminData, { recs, docs, events, loadedAt: Date.now() });
            adminProfiles = profs;
            teamMembers = profs.filter(p => p.approved).map(p => ({ id: p.id, name: txt(p.full_name || p.email || 'Team member'), email: p.email }));''')

ADMIN_CSS = '''
        /* the Admin site */
        #infoModal > .card, #svcModal > .card { max-height: 88vh; overflow-y: auto; }
        .pg-nav { position: absolute; top: 50%; transform: translateY(-50%); width: 2.6rem; height: 2.6rem; border-radius: 999px; background: rgba(2, 6, 23, .6); color: #fff; font-size: 1.5rem; font-weight: 900; display: flex; align-items: center; justify-content: center; z-index: 2; }
        .pg-prev { left: .5rem; } .pg-next { right: .5rem; }
'''

page = f'''<!DOCTYPE html>
<html lang="en">
<!--
    PESTIS ADMIN
    ============
    The Admin site, separate from the Service App (index.html) and the Client Portal (client.html):
    its own page, its own sign-in (admin accounts only) and its own code. They only share the database.
    Open it at  https://<your site>/admin.html  and upload it next to index.html.
    Version {ADMIN_VERSION}
-->
<head>{head}
<style>
{style}
{ADMIN_CSS}
</style>
</head>
<body class="font-sans antialiased min-h-screen flex flex-col">
{LOGIN}
{watchdog}
{markup}
{info_modal}
{EXTRA_MODALS}
    <script>
{SYSTEM}

        // ===================================================================
        //  SHARED HELPERS (dates, services, pest guide, settings ...)
        // ===================================================================
{core}

        // ===================================================================
        //  THE ADMIN PAGES
        // ===================================================================
{code}

        // ---------- start ----------
        document.querySelectorAll('.app-version, .addon-version').forEach(el => {{ el.textContent = window.ADDON_INFO.version; }});
        bootAdmin();
    </script>
</body>
</html>
'''
open(ROOT + 'admin.html', 'w').write(page)
print('admin.html', len(page), file=sys.stderr)
